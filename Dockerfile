FROM node:18-bullseye

# Install FFmpeg for transcoding
RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app

# Copy dependency definitions
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Create uploads folder
RUN mkdir -p uploads

# Expose API port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]