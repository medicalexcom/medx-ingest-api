FROM node:20
WORKDIR /app
COPY package*.json ./
RUN apt-get update && \
    apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev && \
    rm -rf /var/lib/apt/lists/* && \
    npm ci --only=production
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["node","server.js"]
