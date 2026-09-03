FROM mcr.microsoft.com/playwright:v1.51.1-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8080
USER pwuser
CMD ["node", "src/server.js"]
