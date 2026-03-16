#!/usr/bin/env bash
set -euo pipefail

# Fast Nginx setup for Let's Encrypt TLS.
# Usage:
#   sudo bash deploy/scripts/setup-nginx-cloudflare.sh [domain] [email] [project_dir]
# Example:
#   sudo bash deploy/scripts/setup-nginx-cloudflare.sh sp.tanvrr.dpdns.org admin@example.com /opt/silent-pay-indexer

DOMAIN="${1:-sp.tanvrr.dpdns.org}"
EMAIL="${2:-}"
PROJECT_DIR="${3:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NGINX_SITE_PATH="/etc/nginx/sites-available/silent-pay-indexer"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root (use sudo)."
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx not found. Install it first: apt install -y nginx"
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "certbot not found. Install it first: apt install -y certbot python3-certbot-nginx"
  exit 1
fi

# Resolve project dir robustly even if caller passes a wrong path.
if [[ -f "$PROJECT_DIR/deploy/nginx/silent-pay-indexer.conf" ]]; then
  :
elif [[ -f "$(pwd)/deploy/nginx/silent-pay-indexer.conf" ]]; then
  PROJECT_DIR="$(pwd)"
elif [[ -f "$SCRIPT_PROJECT_DIR/deploy/nginx/silent-pay-indexer.conf" ]]; then
  PROJECT_DIR="$SCRIPT_PROJECT_DIR"
fi

TEMPLATE_PATH="$PROJECT_DIR/deploy/nginx/silent-pay-indexer.conf"
if [[ ! -f "$TEMPLATE_PATH" ]]; then
  echo "Nginx template not found: $TEMPLATE_PATH"
  echo "Try running from repo root or pass project_dir explicitly, e.g.:"
  echo "  sudo bash deploy/scripts/setup-nginx-cloudflare.sh $DOMAIN $EMAIL $(pwd)"
  exit 1
fi

echo "Installing Nginx site config for domain: $DOMAIN"
sed "s/server_name sp.tanvrr.dpdns.org;/server_name $DOMAIN;/g" "$TEMPLATE_PATH" > "$NGINX_SITE_PATH"
ln -sfn "$NGINX_SITE_PATH" /etc/nginx/sites-enabled/silent-pay-indexer
rm -f /etc/nginx/sites-enabled/default

echo "Testing Nginx config..."
nginx -t

echo "Reloading Nginx..."
systemctl reload nginx

echo "Issuing TLS certificate with Let's Encrypt..."
if [[ -n "$EMAIL" ]]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$EMAIL"
else
  certbot --nginx -d "$DOMAIN"
fi

echo "Done."
echo "HTTPS is configured for $DOMAIN."
