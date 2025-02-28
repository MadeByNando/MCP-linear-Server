#!/bin/sh
set -e

# Start the MCP server in the background
node dist/server.js &
SERVER_PID=$!

# Function to handle termination signals
cleanup() {
  echo "Stopping MCP server..."
  kill $SERVER_PID
  exit 0
}

# Set up signal trapping
trap cleanup SIGTERM SIGINT

# Keep the container running
echo "MCP server running with PID $SERVER_PID"
echo "Container will stay alive. Use Ctrl+C to stop."

# Wait indefinitely
while true; do
  # Check if server is still running
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "MCP server process has stopped. Restarting..."
    node dist/server.js &
    SERVER_PID=$!
    echo "MCP server restarted with PID $SERVER_PID"
  fi
  sleep 5
done 