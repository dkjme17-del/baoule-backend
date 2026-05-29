FROM node:20-slim

WORKDIR /usr/src/app

# Install only production dependencies for deployment
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
