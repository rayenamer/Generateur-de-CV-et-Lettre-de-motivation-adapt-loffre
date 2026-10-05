FROM node:22-slim
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY server.js .
USER node
EXPOSE 8080
CMD ["node", "server.js"]