#!/bin/bash
# SSL Certificate Generation Script for Development/Testing
# For production, use Let's Encrypt or proper SSL certificates

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SSL_DIR="$PROJECT_ROOT/ssl"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Create SSL directory
mkdir -p "$SSL_DIR"

# Check if OpenSSL is available
if ! command -v openssl &> /dev/null; then
    log_error "OpenSSL is not installed. Please install OpenSSL first."
    exit 1
fi

# Check if certificates already exist
if [ -f "$SSL_DIR/cert.pem" ] && [ -f "$SSL_DIR/key.pem" ]; then
    log_warning "SSL certificates already exist in $SSL_DIR"
    read -p "Do you want to regenerate them? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Keeping existing certificates"
        exit 0
    fi
fi

log_info "Generating self-signed SSL certificate..."

# Generate private key
openssl genrsa -out "$SSL_DIR/key.pem" 2048

# Generate certificate signing request
openssl req -new -key "$SSL_DIR/key.pem" -out "$SSL_DIR/csr.pem" \
    -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"

# Generate self-signed certificate (valid for 1 year)
openssl x509 -req -days 365 -in "$SSL_DIR/csr.pem" \
    -signkey "$SSL_DIR/key.pem" -out "$SSL_DIR/cert.pem"

# Set appropriate permissions
chmod 600 "$SSL_DIR/key.pem"
chmod 644 "$SSL_DIR/cert.pem"

# Clean up CSR
rm "$SSL_DIR/csr.pem"

log_info "SSL certificates generated successfully!"
log_info "Certificate: $SSL_DIR/cert.pem"
log_info "Private key: $SSL_DIR/key.pem"

log_warning "These are self-signed certificates for development/testing only."
log_warning "For production, use Let's Encrypt or purchase proper SSL certificates."

# Instructions for production
cat << EOF

📋 For Production SSL:

1. Let's Encrypt (Free):
   sudo certbot certonly --standalone -d your-domain.com -d www.your-domain.com
   sudo ln -s /etc/letsencrypt/live/your-domain.com/fullchain.pem $SSL_DIR/cert.pem
   sudo ln -s /etc/letsencrypt/live/your-domain.com/privkey.pem $SSL_DIR/key.pem

2. Commercial SSL Certificate:
   - Purchase SSL certificate from a trusted CA
   - Place certificate files in $SSL_DIR/
   - Update nginx.conf with correct paths

3. SSL Configuration in nginx.conf:
   ssl_certificate /etc/nginx/ssl/cert.pem;
   ssl_certificate_key /etc/nginx/ssl/key.pem;

EOF
