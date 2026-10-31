FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0 PORT=3077 DATA_DIR=/data
EXPOSE 3077
CMD ["node", "server.js"]
