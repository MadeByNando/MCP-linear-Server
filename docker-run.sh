#!/bin/bash

# Script to run the MCP Linear Server in Docker

# Check if .env file exists
if [ ! -f .env ]; then
  echo "Error: .env file not found!"
  echo "Please create a .env file with your LINEAR_API_KEY before running this script."
  exit 1
fi

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
  echo "Error: Docker is not installed or not in PATH!"
  exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
  echo "Error: Docker Compose is not installed or not in PATH!"
  exit 1
fi

# Function to display usage
show_usage() {
  echo "Usage: ./docker-run.sh [OPTION]"
  echo "Options:"
  echo "  start       Build and start the container in detached mode"
  echo "  stop        Stop and remove the container"
  echo "  logs        View container logs"
  echo "  restart     Restart the container"
  echo "  dev         Run in development mode with auto-reload"
  echo "  build       Rebuild the Docker image"
  echo "  help        Display this help message"
}

# Process command line arguments
case "$1" in
  start)
    echo "Starting MCP Linear Server in Docker..."
    docker-compose up -d
    echo "Container started. Use './docker-run.sh logs' to view logs."
    ;;
  stop)
    echo "Stopping MCP Linear Server..."
    docker-compose down
    echo "Container stopped."
    ;;
  logs)
    echo "Showing logs (Ctrl+C to exit)..."
    docker-compose logs -f
    ;;
  restart)
    echo "Restarting MCP Linear Server..."
    docker-compose restart
    echo "Container restarted."
    ;;
  dev)
    echo "Starting in development mode with auto-reload..."
    docker run -it --rm \
      -v $(pwd):/app \
      -v /app/node_modules \
      --env-file .env \
      mcp-linear-server \
      npm run dev
    ;;
  build)
    echo "Rebuilding Docker image..."
    docker-compose build --no-cache
    echo "Image rebuilt."
    ;;
  help|*)
    show_usage
    ;;
esac 