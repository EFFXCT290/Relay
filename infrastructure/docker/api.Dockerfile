# API production image — mirrors apps/api/Dockerfile
FROM node:22-alpine AS base
WORKDIR /app
