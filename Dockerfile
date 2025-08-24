FROM node:20-bullseye

# Create app directory
WORKDIR /app

# Copy package manifests first for cached dependency install
COPY package*.json ./

# Install native libraries needed by the canvas package and install Node deps
RUN apt-get update && \
    apt-get install -y \
      libcairo2-dev \
      libpango1.0-dev \
      libjpeg-dev \
      libgif-dev \
      librsvg2-dev && \
    rm -rf /var/lib/apt/lists/* && \
    npm ci --only=production

# Bundle app source
COPY . .

EXPOSE 8080
ENV PORT=8080

CMD ["node", "server.js"]
