# Use the Debian-based Node image to support native modules like canvas
FROM node:20-bullseye
WORKDIR /app
COPY package*.json ./
# Install native dependencies required by the canvas module
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev build-essential && \
    rm -rf /var/lib/apt/lists/* && \
    npm ci --only=production
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["node","server.js"]
