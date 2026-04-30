#!/bin/bash
# Automated Backup System for OpenClaw Agent

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_ROOT/backups"
DATA_DIR="$PROJECT_ROOT/data"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
BACKUP_NAME="backup_$(date +%Y%m%d_%H%M%S)"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

log_info() {
    echo -e "${GREEN}[BACKUP]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Create backup directories
create_backup_dirs() {
    mkdir -p "$BACKUP_DIR"/{data,roadmap,database,config}
    log_info "Backup directories created"
}

# Backup SQLite databases
backup_databases() {
    log_info "Backing up SQLite databases..."

    if [ -d "$DATA_DIR" ]; then
        # Find all .db files and back them up
        find "$DATA_DIR" -name "*.db" -type f -exec bash -c '
            db_file="$1"
            db_name=$(basename "$db_file" .db)
            backup_path="'$BACKUP_DIR/data'/${db_name}_${TIMESTAMP}.db"

            cp "$db_file" "$backup_path"
            gzip -f "$backup_path"
            echo "Backed up: $db_name"
        ' _ {} \;

        log_info "Database backup completed"
    else
        log_warning "No data directory found"
    fi
}

# Backup configuration files
backup_config() {
    log_info "Backing up configuration files..."

    # Backup environment files
    if [ -f "$PROJECT_ROOT/.env" ]; then
        cp "$PROJECT_ROOT/.env" "$BACKUP_DIR/config/.env_${TIMESTAMP}"
    fi

    # Backup nginx configuration
    if [ -f "$PROJECT_ROOT/nginx.conf" ]; then
        cp "$PROJECT_ROOT/nginx.conf" "$BACKUP_DIR/config/nginx_${TIMESTAMP}.conf"
    fi

    # Backup docker-compose configuration
    if [ -f "$PROJECT_ROOT/docker-compose.yml" ]; then
        cp "$PROJECT_ROOT/docker-compose.yml" "$BACKUP_DIR/config/docker-compose_${TIMESTAMP}.yml"
    fi

    log_info "Configuration backup completed"
}

# Backup roadmap data
backup_roadmaps() {
    log_info "Backing up roadmap data..."

    if [ -d "$DATA_DIR/roadmap.db" ]; then
        cp "$DATA_DIR/roadmap.db" "$BACKUP_DIR/roadmap/roadmap_${TIMESTAMP}.db"
        gzip -f "$BACKUP_DIR/roadmap/roadmap_${TIMESTAMP}.db"
    fi

    if [ -d "$DATA_DIR/memories" ]; then
        tar -czf "$BACKUP_DIR/roadmap/memories_${TIMESTAMP}.tar.gz" -C "$DATA_DIR" memories/
    fi

    log_info "Roadmap backup completed"
}

# Create backup manifest
create_manifest() {
    log_info "Creating backup manifest..."

    cat > "$BACKUP_DIR/manifest_${TIMESTAMP}.txt" << EOF
OpenClaw Agent Backup Manifest
=============================
Backup ID: $BACKUP_NAME
Timestamp: $TIMESTAMP
Host: $(hostname)
User: $(whoami)

Contents:
$(find "$BACKUP_DIR" -name "*_${TIMESTAMP}*" -type f | sort)

Disk Usage:
$(du -sh "$BACKUP_DIR"/*_${TIMESTAMP}* 2>/dev/null || echo "No backup files found")

System Information:
OS: $(uname -s) $(uname -r)
Architecture: $(uname -m)
Disk Space: $(df -h "$PROJECT_ROOT" | tail -1)

EOF

    log_info "Backup manifest created"
}

# Clean old backups
cleanup_old_backups() {
    log_info "Cleaning up old backups (older than $RETENTION_DAYS days)..."

    # Find and remove backup directories older than retention period
    find "$BACKUP_DIR" -name "backup_*" -type d -mtime +$RETENTION_DAYS -exec rm -rf {} \;

    # Find and remove individual backup files older than retention period
    find "$BACKUP_DIR" -type f -mtime +$RETENTION_DAYS -delete

    log_info "Old backup cleanup completed"
}

# Backup PostgreSQL (if using PostgreSQL)
backup_postgres() {
    if [ -n "$POSTGRES_HOST" ] && [ -n "$POSTGRES_PASSWORD" ]; then
        log_info "Backing up PostgreSQL database..."

        # Create PostgreSQL backup
        PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
            -h "$POSTGRES_HOST" \
            -U "$POSTGRES_USER" \
            -d "$POSTGRES_DB" \
            -F c \
            -f "$BACKUP_DIR/database/postgres_${TIMESTAMP}.dump"

        gzip -f "$BACKUP_DIR/database/postgres_${TIMESTAMP}.dump"

        log_info "PostgreSQL backup completed"
    fi
}

# Verify backup integrity
verify_backup() {
    log_info "Verifying backup integrity..."

    local backup_count=$(find "$BACKUP_DIR" -name "*_${TIMESTAMP}*" -type f | wc -l)

    if [ "$backup_count" -eq 0 ]; then
        log_error "Backup verification failed - no backup files found"
        return 1
    fi

    log_info "Backup verification passed - $backup_count backup files created"
    return 0
}

# Calculate backup size
calculate_size() {
    local backup_size=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
    log_info "Total backup size: $backup_size"
}

# Send notification (if configured)
send_notification() {
    local status=$1
    local message="OpenClaw Agent Backup ${status}: ${BACKUP_NAME}"

    # Add webhook or email notification here if desired
    # Example: curl -X POST "$WEBHOOK_URL" -d "text=$message"

    log_info "Notification: $message"
}

# Main backup function
main() {
    log_info "Starting backup process: $BACKUP_NAME"

    local start_time=$(date +%s)

    create_backup_dirs
    backup_databases
    backup_config
    backup_roadmaps
    backup_postgres
    create_manifest
    cleanup_old_backups

    if verify_backup; then
        calculate_size

        local end_time=$(date +%s)
        local duration=$((end_time - start_time))

        log_info "Backup completed successfully in ${duration} seconds"
        send_notification "SUCCESS"
    else
        log_error "Backup failed"
        send_notification "FAILED"
        exit 1
    fi
}

# Handle script arguments
case "${1:-}" in
    --verify-only)
        verify_backup
        ;;
    --cleanup-only)
        cleanup_old_backups
        ;;
    *)
        main
        ;;
esac
