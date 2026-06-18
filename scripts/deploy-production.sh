#!/usr/bin/env bash
set -euo pipefail

REGION="us-east-1"
ECR_REPO="042502209102.dkr.ecr.us-east-1.amazonaws.com/vivian-barnacle-prod"
ECS_CLUSTER="vivian-barnacle-prod"
ECS_SERVICE="vivian-barnacle-prod-app"
TASK_FAMILY="vivian-barnacle-prod-app"

SHA=$(git rev-parse HEAD)
IMAGE="${ECR_REPO}:${SHA}"

echo "==> Deploying ${SHA} to production"

echo "==> Logging in to ECR"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "042502209102.dkr.ecr.${REGION}.amazonaws.com"

echo "==> Building image"
docker build --platform linux/amd64 -t "$IMAGE" .

echo "==> Pushing image to ECR"
docker push "$IMAGE"

echo "==> Registering new task definition"
aws ecs register-task-definition \
  --cli-input-json "$(sed "s|IMAGE_PLACEHOLDER|${IMAGE}|" .aws/task-definition-production.json)"

echo "==> Updating ECS service"
aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$TASK_FAMILY" \
  --force-new-deployment

echo "==> Done. Service updating with image ${SHA}"
