# VPS Deployment Guide (Nginx + HTTPS)

This guide deploys `silent-pay-indexer` behind Nginx on a Linux VPS with HTTPS for:

- `sp.tanvrr.dpdns.org`

## 1. Prerequisites

- Public VPS with Ubuntu/Debian-like package manager.
- DNS `A` record for `sp.tanvrr.dpdns.org` pointing to VPS public IP.
- Ports `80` and `443` open in cloud firewall/router and VPS firewall.
- Node.js 20+ and npm installed.

## 2. Install system packages

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 3. Prepare app directory and user-owned data dir

```bash
sudo mkdir -p /opt/silent-pay-indexer
sudo mkdir -p /var/lib/silent-pay-indexer
sudo chown -R "$USER":"$USER" /opt/silent-pay-indexer /var/lib/silent-pay-indexer
```

Copy the project to `/opt/silent-pay-indexer` (git clone or rsync), then:

```bash
cd /opt/silent-pay-indexer
npm ci
npm run build
```

## 4. Configure application

Use the production config in `config/config.yaml` and update at minimum:

- `bitcoinCore.rpcHost`
- `bitcoinCore.rpcPort`
- `bitcoinCore.rpcUser`
- `bitcoinCore.rpcPass`

Keep `app.port: 3000` because Nginx will reverse proxy to it.

If you prefer env-based secrets, use template:

```bash
sudo mkdir -p /etc/silent-pay-indexer
sudo cp deploy/systemd/silent-pay-indexer.env.example /etc/silent-pay-indexer/silent-pay-indexer.env
sudo nano /etc/silent-pay-indexer/silent-pay-indexer.env
```

Set secure file permissions:

```bash
sudo chmod 600 /etc/silent-pay-indexer/silent-pay-indexer.env
```

## 5. Setup systemd service

Copy service file and adjust `User`/`Group` if your VPS username is not `sahil`:

```bash
sudo cp deploy/systemd/silent-pay-indexer.service /etc/systemd/system/silent-pay-indexer.service
sudo nano /etc/systemd/system/silent-pay-indexer.service
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now silent-pay-indexer
sudo systemctl status silent-pay-indexer --no-pager
```

Follow logs:

```bash
journalctl -u silent-pay-indexer -f
```

## 6. Setup Nginx reverse proxy

```bash
sudo cp deploy/nginx/silent-pay-indexer.conf /etc/nginx/sites-available/silent-pay-indexer
sudo ln -sf /etc/nginx/sites-available/silent-pay-indexer /etc/nginx/sites-enabled/silent-pay-indexer
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Verify HTTP works first:

```bash
curl -i http://sp.tanvrr.dpdns.org/health
```

## 7. Enable HTTPS

Choose one of the following options.

### Option A: Let's Encrypt (public certificate)

Issue cert and auto-configure Nginx redirect to HTTPS:

```bash
sudo certbot --nginx -d sp.tanvrr.dpdns.org
```

Choose redirect to HTTPS when prompted.

Test auto-renew:

```bash
sudo certbot renew --dry-run
```

### Option B: Cloudflare Origin Certificate (use your existing Cloudflare certs)

Use this when DNS is proxied through Cloudflare (orange cloud).

1. Put cert and key on VPS:

```bash
sudo mkdir -p /etc/ssl/private
sudo cp /path/to/cloudflare-origin.pem /etc/ssl/certs/cloudflare-origin.pem
sudo cp /path/to/cloudflare-origin.key /etc/ssl/private/cloudflare-origin.key
sudo chmod 600 /etc/ssl/private/cloudflare-origin.key
```

2. Enable the Cloudflare-specific Nginx config:

```bash
sudo cp deploy/nginx/silent-pay-indexer.cloudflare-origin.conf /etc/nginx/sites-available/silent-pay-indexer
sudo ln -sf /etc/nginx/sites-available/silent-pay-indexer /etc/nginx/sites-enabled/silent-pay-indexer
sudo nginx -t
sudo systemctl reload nginx
```

3. In Cloudflare dashboard for `sp.tanvrr.dpdns.org`:

- Keep proxy enabled (orange cloud).
- Set SSL/TLS mode to `Full (strict)`.

## 8. Firewall (if using UFW)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## 9. Health checks

```bash
curl -i https://sp.tanvrr.dpdns.org/health
```

For websocket reachability:

- Confirm Nginx keeps `Upgrade` and `Connection` headers (already in provided config).

## 10. Updating deployment

```bash
cd /opt/silent-pay-indexer
git pull
npm ci
npm run build
sudo systemctl restart silent-pay-indexer
```

## Notes on certificates

- You do not need to buy a certificate.
- Use Let's Encrypt for direct public TLS from your VPS.
- Use Cloudflare Origin cert only when traffic is proxied by Cloudflare.
- For Let's Encrypt issuance, domain must resolve publicly to your VPS and port `80` must be reachable.
