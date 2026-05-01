# 🚀 AI Assistant - Production Deployment Guide

Complete guide for deploying AI Assistant to production with Docker, monitoring, and security hardening.

## 📋 Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- 2GB RAM minimum (4GB recommended)
- 20GB disk space
- SSL certificate (for production)
- Valid API credentials for all integrations

## 🔧 Initial Setup

### 1. Environment Configuration

```bash
# Copy production environment template
cp .env.production.template .env

# Edit with your production values
nano .env
```

### 2. SSL Certificates

**For Development:**

```bash
# Generate self-signed certificates
npm run ssl:generate
```

**For Production (Let's Encrypt):**

```bash
# Install certbot
sudo apt-get install certbot

# Generate certificates
sudo certbot certonly --standalone -d your-domain.com

# Copy certificates
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem ssl/cert.pem
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem ssl/key.pem
```

### 3. Create Required Directories

```bash
# Directories are created automatically by deploy script
mkdir -p data/{memories,audit,roadmap}
mkdir -p logs/{nginx,app}
mkdir -p backups/{data,roadmap,database,config}
```

## 🐳 Docker Deployment

### Quick Start

```bash
# Build and start all services
npm run docker:build
npm run docker:up

# View logs
npm run docker:logs
```

### Production Deployment

```bash
# Deploy to production with full monitoring
npm run deploy:production
```

### Available Profiles

- **Default**: Basic application container
- **Production**: Includes nginx reverse proxy
- **Monitoring**: Adds Prometheus and Grafana

```bash
# Deploy with monitoring
docker-compose --profile production --profile monitoring up -d
```

## 🔒 Security Hardening

### Implemented Security Measures

✅ **Multi-layer Guardrails**: Code-level protection for destructive actions
✅ **Rate Limiting**: API endpoint rate limiting
✅ **SSL/TLS**: HTTPS only in production
✅ **Security Headers**: CSP, XSS protection, frame options
✅ **Non-root User**: Containers run as non-privileged user
✅ **Read-only Root**: Immutable container filesystem
✅ **Secrets Management**: Environment variables for sensitive data
✅ **Audit Logging**: All actions logged to `data/audit/`
✅ **Network Isolation**: Docker network segmentation

### Security Checklist

- [ ] SSL certificates configured
- [ ] Strong passwords in `.env`
- [ ] Firewall rules configured (ports 80, 443 only)
- [ ] Regular backups scheduled
- [ ] Monitoring setup
- [ ] Log rotation configured
- [ ] Incident response plan
- [ ] Security audit performed

## 📊 Monitoring

### Access Monitoring Dashboards

**Grafana:** http://localhost:3001

- Default credentials: admin / (check .env)
- Pre-configured dashboards for application metrics

**Prometheus:** http://localhost:9090

- Raw metrics and query interface
- Alert management

### Key Metrics to Monitor

- **API Response Time**: < 500ms target
- **Error Rate**: < 1% target
- **Memory Usage**: Alert at 80%
- **CPU Usage**: Alert at 70%
- **Database Connections**: Monitor pool usage
- **Guardrails Actions**: Track blocked/approved actions

## 💾 Backup & Recovery

### Automated Backups

```bash
# Run manual backup
npm run backup

# Schedule with cron (daily at 2 AM)
0 2 * * * cd /path/to/app && npm run backup
```

### Backup Contents

- SQLite databases
- Roadmap data
- Conversation memories
- Configuration files
- Audit logs

### Recovery Procedure

```bash
# Stop services
npm run docker:down

# Restore from backup
# 1. Copy databases back to data/
# 2. Restore configuration files
# 3. Restart services
npm run docker:up
```

## 🔍 Health Checks

### Application Health

```bash
# Basic health check
curl http://localhost:3000/health

# Detailed health check
curl http://localhost:3000/health | jq
```

### Service Status

```bash
# Check all containers
docker-compose ps

# Check application logs
docker-compose logs -f app

# Check nginx logs
docker-compose logs -f nginx
```

## 🧪 Production Testing

### Run Production Readiness Tests

```bash
# Ensure server is running first
npm run dev &

# Run production tests
npm run test:production
```

### Test Coverage

- ✅ Environment variables validation
- ✅ API health and connectivity
- ✅ Integration status (OpenCode, Jira, GitLab)
- ✅ Database connectivity
- ✅ Memory management system
- ✅ Guardrails functionality
- ✅ File system permissions
- ✅ Docker configuration
- ✅ API performance (<3s response time)
- ✅ Security headers
- ✅ Rate limiting

## 🎯 Performance Tuning

### Resource Allocation

**Default Limits (docker-compose.yml):**

- CPU: 2 cores (max), 0.5 cores (reserved)
- Memory: 2GB (max), 512MB (reserved)

**For High Traffic:**

```yaml
deploy:
  resources:
    limits:
      cpus: "4"
      memory: 4G
```

### Database Optimization

- Use PostgreSQL for production (vs SQLite)
- Enable Redis for caching
- Configure connection pooling
- Regular vacuum and analyze

## 🚨 Troubleshooting

### Common Issues

**Port Already in Use:**

```bash
# Find process on port 3000
netstat -ano | findstr :3000

# Kill process
taskkill //PID <process_id> //F
```

**Database Lock Issues:**

```bash
# Check SQLite locks
ls -la data/*.db-lock

# Restart services
docker-compose restart app
```

**Memory Issues:**

```bash
# Check memory usage
docker stats

# Increase limits in docker-compose.yml
```

**SSL Certificate Issues:**

```bash
# Regenerate certificates
npm run ssl:generate

# Verify nginx configuration
docker-compose logs nginx
```

## 📈 Scaling Strategy

### Horizontal Scaling

```bash
# Scale application containers
docker-compose up -d --scale app=3
```

### Load Balancer Setup

- Use nginx load balancing
- Configure health checks
- Enable session stickiness if needed

### Database Scaling

- Migrate from SQLite to PostgreSQL
- Implement read replicas
- Consider connection pooling

## 🔄 Update & Maintenance

### Application Updates

```bash
# 1. Backup current version
npm run backup

# 2. Pull latest code
git pull origin main

# 3. Build new images
npm run docker:build

# 4. Deploy with zero downtime
npm run deploy
```

### Database Migrations

```bash
# Run migrations
docker-compose exec app npm run migrate

# Verify migration
docker-compose exec app npm run test:production
```

## 📞 Support & Monitoring

### Log Analysis

```bash
# Application logs
tail -f logs/app/output.log

# Nginx access logs
tail -f logs/nginx/access.log

# Error logs
tail -f logs/nginx/error.log
```

### Incident Response

1. **Detection**: Monitor alerts
2. **Assessment**: Check logs and metrics
3. **Containment**: Scale up or rollback if needed
4. **Resolution**: Apply fix
5. **Recovery**: Verify system health
6. **Post-Mortem**: Document and improve

---

**Production Deployment Status**: ✅ READY

The AI Assistant is production-ready with comprehensive security, monitoring, and backup systems in place.

**Next Steps:**

1. Complete environment configuration
2. Set up SSL certificates
3. Run production tests
4. Configure monitoring alerts
5. Schedule regular backups
6. Document your specific procedures
