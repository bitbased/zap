FROM nvidia/cuda:12.1.1-devel-ubuntu22.04

ARG INSTALL_ALL=true
ARG INSTALL_NODE
ARG INSTALL_PYTHON
ARG INSTALL_PYTORCH
ARG INSTALL_VULKAN_GL
ARG INSTALL_EXTRAS
ARG INSTALL_HUGGINGFACE
ARG INSTALL_MESA
ARG INSTALL_EGL
ARG INSTALL_NGINX

ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics
ENV INSTALL_NGINX=${INSTALL_NGINX}

# --- Core build deps
RUN apt-get update && apt-get install -y \
    build-essential curl ca-certificates gnupg git git-lfs tar g++ \
    && git lfs install --system \
    && rm -rf /var/lib/apt/lists/*

# --- NVIDIA Container Toolkit repo (ensures we get nvidia-utils-565)
RUN apt-get update && apt-get install -y curl gnupg && \
    curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | \
      gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit.gpg && \
    curl -s -L https://nvidia.github.io/libnvidia-container/ubuntu22.04/libnvidia-container.list | \
      sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit.gpg] https://#' \
      > /etc/apt/sources.list.d/nvidia-container-toolkit.list && \
    apt-get update

# --- Minimal Vulkan + OpenGL via NVIDIA GLVND
RUN if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_VULKAN_GL" = "true" ]; then \
    apt-get update && apt-get install -y --no-install-recommends \
    libx11-dev libxext-dev libvulkan1 \
    libglvnd0 libgl1 libglx0 libegl1 libgles2 \
    && rm -rf /var/lib/apt/lists/*; \
    mkdir -p /usr/share/vulkan/icd.d && \
    echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3.0"}}' \
      > /usr/share/vulkan/icd.d/nvidia_icd.json && \
    mkdir -p /usr/share/glvnd/egl_vendor.d && \
    echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}' \
      > /usr/share/glvnd/egl_vendor.d/10_nvidia.json; \
  fi

# --- Optional: MESA fallback stack
RUN if [ "$INSTALL_MESA" = "true" ]; then \
    apt-get update && apt-get install -y \
    libgl1-mesa-glx libegl1-mesa libgles2-mesa libglapi-mesa \
    libgl1-mesa-dev libegl1-mesa-dev libgles2-mesa-dev libosmesa6-dev \
    libgbm-dev libgbm1 libdrm-dev \
    && rm -rf /var/lib/apt/lists/*; \
  fi

# --- Optional: EGL support and GPU runtime
RUN if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_EGL" = "true" ]; then \
    apt-get update && apt-get install -y \
    libgbm1 libnvidia-egl-gbm1 \
    && rm -rf /var/lib/apt/lists/*; \
  fi

# --- Node.js 22
RUN if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_NODE" = "true" ]; then \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get update && apt-get install -y nodejs && \
    npm install -g ts-node typescript && \
    node -v && npm -v && ts-node --version; \
  fi

# --- Python + OpenGL
RUN if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_PYTHON" = "true" ]; then \
    apt-get update && apt-get install -y python3 python3-venv python3-dev python3-pip python3-setuptools && \
    python3 -m pip install --upgrade pip && \
    pip install PyOpenGL PyOpenGL-accelerate moderngl; \
  fi

# --- PyCUDA (GPU)
RUN if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_PYTHON" = "true" ]; then \
  pip install pycuda numpy pillow; \
  fi

# --- PyTorch (GPU)
RUN if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_PYTORCH" = "true" ]; then \
    pip install torch==2.5.1 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121; \
  fi

# --- Extras
RUN if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_EXTRAS" = "true" ]; then \
    apt-get update && apt-get install -y \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    libopenblas-dev liblapack-dev ffmpeg libsm6 libxext6 libxrender-dev \
    && rm -rf /var/lib/apt/lists/* && \
    pip install numpy scipy opencv-python transformers; \
  fi

# --- Hugging Face
RUN if [ "$INSTALL_ALL" = "true" ] || [ "$INSTALL_HUGGINGFACE" = "true" ]; then \
    pip install transformers diffusers datasets accelerate tokenizers huggingface-hub hf-transfer && \
    pip install peft bitsandbytes optimum sentencepiece protobuf || true; \
  fi

# sentencepiece protobuf, are extras not HF?

# --- NGINX reverse proxy with self-signed SSL
# Copy NGINX default site configuration for proxy
COPY nginx-default.conf /tmp/nginx-default.conf
RUN if [ "$INSTALL_NGINX" = "true" ]; then \
    apt-get update && apt-get install -y nginx openssl && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /etc/nginx/ssl && \
    openssl req -x509 -nodes -days 365 \
      -subj "/CN=localhost" \
      -newkey rsa:2048 \
      -keyout /etc/nginx/ssl/selfsigned.key \
      -out /etc/nginx/ssl/selfsigned.crt && \
    rm /etc/nginx/sites-enabled/default && \
    cp /tmp/nginx-default.conf /etc/nginx/conf.d/default.conf && \
    rm /tmp/nginx-default.conf; \
  fi

ENV NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics

# --- Runtime config
WORKDIR /zap

ARG ZAP_PORT
ARG ZAP_CONFIG
ARG ZAP_USERNAME
ARG ZAP_PASSWORD
ARG ZAP_SECRET
ARG ZAP_TOKEN

ENV ZAP_PORT=${ZAP_PORT}
ENV ZAP_CONFIG=${ZAP_CONFIG}
ENV ZAP_USERNAME=${ZAP_USERNAME}
ENV ZAP_PASSWORD=${ZAP_PASSWORD}
ENV ZAP_SECRET=${ZAP_SECRET}
ENV ZAP_TOKEN=${ZAP_TOKEN}
ENV XDG_RUNTIME_DIR=/tmp/runtime-root

RUN mkdir -p /tmp/runtime-root

COPY package.json ./
COPY tsconfig.base.json ./
COPY tsconfig.json ./

RUN npm install && npm install -g ts-node typescript gl

COPY src src
EXPOSE 3000
EXPOSE 80
EXPOSE 443

CMD ["sh", "-c", "if [ \"$INSTALL_NGINX\" = \"true\" ]; then nginx -g 'daemon off;' & fi && exec ts-node src/zap-host.ts"]
