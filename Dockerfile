FROM node:18-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

# Set environment variable for Railway
ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "server.js"]