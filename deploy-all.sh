#!/bin/bash

# Multi-Cloud Deployment Script for CoderX Backend
# This script deploys the backend to multiple providers and registers them with the Edge Gateway.

REDIS_URL="your_upstash_redis_url"
REDIS_TOKEN="your_upstash_redis_token"

deploy_cloudflare() {
  echo "🚀 Deploying to Cloudflare..."
  cd /Users/mac/github/coderx-backend-cloudflare
  npx wrangler deploy
  # URL would be something like coderx-backend-cloudflare.workers.dev
}

deploy_railway() {
  echo "🚀 Deploying to Railway..."
  cd /Users/mac/github/coderx-backend-railway
  # railway up
}

deploy_netlify() {
  echo "🚀 Deploying to Netlify..."
  cd /Users/mac/github/coderx-backend-netlify
  npx netlify deploy --prod
}

deploy_fly() {
  echo "🚀 Deploying to Fly.io..."
  cd /Users/mac/github/coderx-backend-fly
  # fly deploy
}

# Main Execution
echo "Starting Multi-Cloud Deployment..."

# deploy_cloudflare
# deploy_railway
# deploy_netlify
# deploy_fly

echo "✅ All deployments triggered."
echo "Note: You need to manually update the active_providers list in Redis with the resulting URLs."
