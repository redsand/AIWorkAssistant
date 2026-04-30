#!/bin/bash
# Production deployment script for OpenClaw Agent

set -e  # Exit on error
set -o pipefail  # Exit on pipe failure

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_ROOT/backups"
LOG_DIR="$PROJECT_ROOT/logs"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Create necessary directories
create_directories() {
    log_info "Creating necessary directories..."
    mkdir -p "$BACKUP_DIR"/{postgres,data,roadmap}
    mkdir -p "$LOG_DIR"/{nginx,app}
    mkdir -p "$PROJECT_ROOT"/data/{memories,audit}
    mkdir -p "$PROJECT_ROOT"/ssl
    mkdir -p "$PROJECT_ROOT"/monitoring/{prometheus,grafana/dashboards,grafana/datasources}
    log_success "Directories created"
}

# Backup existing data
backup_data() {
    log_info "Creating backup of existing data..."
    local backup_name="backup_$(date +%Y%m%d_%H%M%S)"
    local backup_path="$BACKUP_DIR/$backup_name"

    mkdir -p "$backup_path"

    # Backup SQLite databases
    if [ -d "$PROJECT_ROOT/data" ]; then
        cp -r "$PROJECT_ROOT/data" "$backup_path/" 2>/dev/null || true
    fi

    # Backup environment files
    cp "$PROJECT_ROOT/.env" "$backup_path/.env.bak" 2>/dev/null || true

    log_success "Backup created: $backup_path"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check if Docker is installed
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install Docker first."
        exit 1
    fi

    # Check if Docker Compose is installed
    if ! command -v docker-compose &> /dev/null; then
        log_error "Docker Compose is not installed. Please install Docker Compose first."
        exit 1
    fi

    # Check if .env file exists
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
        log_error ".env file not found. Please create .env file with required environment variables."
        exit 1
    fi

    log_success "Prerequisites check passed"
}

# Build Docker images
build_images() {
    log_info "Building Docker images..."
    cd "$PROJECT_ROOT"
    docker-compose build --no-cache
    log_success "Docker images built successfully"
}

# Stop existing services
stop_services() {
    log_info "Stopping existing services..."
    cd "$PROJECT_ROOT"
    docker-compose down
    log_success "Services stopped"
}

# Start services
start_services() {
    local profile=$1

    log_info "Starting services with profile: $profile..."
    cd "$PROJECT_ROOT"

    if [ "$profile" = "production" ]; then
        docker-compose --profile production --profile monitoring up -d
    else
        docker-compose up -d
    fi

    log_success "Services started"
}

# Run database migrations
run_migrations() {
    log_info "Running database migrations..."

    # Initialize roadmap database if needed
    if [ -f "$PROJECT_ROOT/node_modules/.bin/tsx" ]; then
        cd "$PROJECT_ROOT"
        npm run init:roadmap 2>/dev/null || true
    fi

    log_success "Database migrations completed"
}

# Health check
health_check() {
    log_info "Performing health check..."

    local max_attempts=30
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if curl -f -s http://localhost:3000/health > /dev/null 2>&1; then
            log_success "Health check passed"
            return 0
        fi

        log_info "Waiting for services to be ready... ($attempt/$max_attempts)"
        sleep 2
        ((attempt++))
    done

    log_error "Health check failed - services did not start in time"
    return 1
}

# Show service status
show_status() {
    log_info "Service status:"
    cd "$PROJECT_ROOT"
    docker-compose ps
}

# Show logs
show_logs() {
    local service=$1

    log_info "Showing logs for: ${service:-all services}"
    cd "$PROJECT_ROOT"

    if [ -z "$service" ]; then
        docker-compose logs --tail=50 -f
    else
        docker-compose logs --tail=50 -f "$service"
    fi
}

# Main deployment function
deploy() {
    local environment=${1:-production}

    log_info "Starting deployment for environment: $environment"

    create_directories
    check_prerequisites
    backup_data
    stop_services
    build_images
    start_services "$environment"
    run_migrations
    health_check
    show_status

    log_success "Deployment completed successfully!"
    log_info "Application is available at: http://localhost:3000"

    if [ "$environment" = "production" ]; then
        log_info "Grafana monitoring is available at: http://localhost:3001"
        log_info "Prometheus metrics are available at: http://localhost:9090"
    fi
}

# Rollback function
rollback() {
    log_warning "Initiating rollback..."

    local latest_backup=$(ls -t "$BACKUP_DIR" | head -1)

    if [ -z "$latest_backup" ]; then
        log_error "No backup found for rollback"
        exit 1
    fi

    log_info "Rolling back to: $latest_backup"

    stop_services

    # Restore data
    if [ -d "$BACKUP_DIR/$latest_backup/data" ]; then
        rm -rf "$PROJECT_ROOT/data"
        cp -r "$BACKUP_DIR/$latest_backup/data" "$PROJECT_ROOT/"
    fi

    # Restore environment
    if [ -f "$BACKUP_DIR/$latest_backup/.env.bak" ]; then
        cp "$BACKUP_DIR/$latest_backup/.env.bak" "$PROJECT_ROOT/.env"
    fi

    start_services "production"
    health_check

    log_success "Rollback completed"
}

# Script usage
usage() {
    cat << EOF
Usage: $0 [command] [options]

Commands:
    deploy [environment]    Deploy the application (default: production)
    rollback               Rollback to the previous backup
    start [profile]         Start services without deploying
    stop                   Stop all services
    restart [profile]      Restart services
    status                 Show service status
    logs [service]         Show logs (all services or specific service)
    backup                 Create a backup
    health                 Run health check

Examples:
    $0 deploy              # Deploy to production
    $0 deploy production   # Deploy to production with monitoring
    $0 deploy staging      # Deploy to staging
    $0 rollback            # Rollback to previous backup
    $0 logs app            # Show logs for app service
    $0 status              # Show service status

EOF
    exit 1
}

# Main script logic
main() {
    case "${1:-}" in
        deploy)
            deploy "${2:-production}"
            ;;
        rollback)
            rollback
            ;;
        start)
            start_services "${2:-}"
            ;;
        stop)
            stop_services
            ;;
        restart)
            stop_services
            start_services "${2:-}"
            ;;
        status)
            show_status
            ;;
        logs)
            show_logs "${2:-}"
            ;;
        backup)
            create_directories
            backup_data
            ;;
        health)
            health_check
            ;;
        *)
            usage
            ;;
    esac
}

# Run main function with all arguments
main "$@"
