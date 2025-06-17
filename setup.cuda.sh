
#!/usr/bin/env bash
# setup.sh — install host dependencies as in Dockerfile.cuda
# set -euo pipefail

# Parse optional flags
RUN_HOST=false
for arg in "$@"; do
  case "$arg" in
    --run) RUN_HOST=true ;;
  esac
done

# Load environment variables from .env if present
if [ -f .env ]; then
  echo "Loading environment variables from .env"
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
fi

# Default versions (can be overridden via .env or environment)
NODE_VERSION=${NODE_VERSION:-22}
PYTHON_VERSION=${PYTHON_VERSION:-3}

# Ensure running as root
if [ "$EUID" -ne 0 ]; then
  echo "This script must be run as root or via sudo"
  exit 1
fi

echo "Installing core build dependencies..."
apt-get update
apt-get install -y build-essential curl ca-certificates gnupg git git-lfs tar g++
git lfs install --system
rm -rf /var/lib/apt/lists/*

echo "Configuring NVIDIA Container Toolkit repository..."
apt-get update
apt-get install -y curl gnupg
curl -s -L https://nvidia.github.io/libnvidia-container/gpgkey | \
  gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/ubuntu22.04/libnvidia-container.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit.gpg] https://#' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
apt-get update

echo "Installing Vulkan and OpenGL (GLVND)..."
apt-get update
apt-get install -y --no-install-recommends \
  libx11-dev libxext-dev libvulkan1 \
  libglvnd0 libgl1 libglx0 libegl1 libgles2
rm -rf /var/lib/apt/lists/*
mkdir -p /usr/share/vulkan/icd.d
echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3.0"}}' \
  > /usr/share/vulkan/icd.d/nvidia_icd.json
mkdir -p /usr/share/glvnd/egl_vendor.d
echo '{"file_format_version":"1.0.0","ICD":{"library_path":"libEGL_nvidia.so.0"}}' \
  > /usr/share/glvnd/egl_vendor.d/10_nvidia.json

echo "Installing MESA fallback libraries..."
apt-get update
apt-get install -y \
  libgl1-mesa-glx libegl1-mesa libgles2-mesa libglapi-mesa \
  libgl1-mesa-dev libegl1-mesa-dev libgles2-mesa-dev libosmesa6-dev \
  libgbm-dev libgbm1 libdrm-dev
rm -rf /var/lib/apt/lists/*

echo "Installing EGL support and GPU runtime..."
apt-get update
apt-get install -y libgbm1 libnvidia-egl-gbm1
rm -rf /var/lib/apt/lists/*

echo "Installing Node.js (v${NODE_VERSION}) and global npm packages..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get update
apt-get install -y nodejs
npm install -g ts-node typescript

echo "Installing Python (v${PYTHON_VERSION}) and common packages..."
apt-get update
apt-get install -y python${PYTHON_VERSION} python${PYTHON_VERSION}-venv python${PYTHON_VERSION}-dev python${PYTHON_VERSION}-distutils curl
curl -sS https://bootstrap.pypa.io/get-pip.py | python3
python3 -m pip install --no-cache-dir --upgrade pip
python3 -m pip install --no-cache-dir PyOpenGL PyOpenGL-accelerate moderngl

echo "Installing additional system libraries for Python extras..."
apt-get update
apt-get install -y \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
  libopenblas-dev liblapack-dev ffmpeg libsm6 libxext6 libxrender-dev
rm -rf /var/lib/apt/lists/*

echo "Installing Python libraries via pip..."
python3 -m pip install --no-cache-dir pillow sixel
python3 -m pip install --no-cache-dir numpy scipy opencv-python transformers

echo "Installing PyCUDA and related Python packages..."
python3 -m pip install --no-cache-dir pycuda numpy pillow

echo "Installing PyTorch (CUDA) and Hugging Face libraries..."
python3 -m pip install --no-cache-dir torch==2.5.1 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
python3 -m pip install --no-cache-dir transformers diffusers datasets accelerate tokenizers huggingface-hub hf-transfer
python3 -m pip install --no-cache-dir peft bitsandbytes optimum sentencepiece protobuf || true

echo "Installing or updating NGINX and generating self-signed SSL certificate..."
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update
  apt-get install -y nginx openssl
  rm -rf /var/lib/apt/lists/*
  mkdir -p /etc/nginx/ssl
  openssl req -x509 -nodes -days 365 \
    -subj "/CN=localhost" \
    -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/selfsigned.key \
    -out /etc/nginx/ssl/selfsigned.crt
  rm -f /etc/nginx/sites-enabled/default
  cp nginx-default.conf /etc/nginx/conf.d/default.conf
else
  echo "Nginx already installed"
fi

echo "Installing project dependencies..."
npm install
npm install -g gl

echo "Setup complete!"

# If requested, start nginx and zap-host
if [ "${RUN_HOST}" = "true" ]; then
  echo "Starting Nginx and Zap host..."
  nginx -g 'daemon off;' &
  exec ts-node src/zap-host.ts
fi
