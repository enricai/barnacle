#!/bin/bash
# Prepare Prisma client for CI/CD builds
# This script generates the Prisma client without requiring a database connection

set -e

echo "Generating Prisma client..."
npx prisma generate

echo "Prisma client generated successfully"
