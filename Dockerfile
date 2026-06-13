FROM node:26-alpine
WORKDIR /app
COPY router/ ./router/
COPY proxy/ ./proxy/
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY stats/ ./stats/
COPY scripts/ ./scripts/
COPY package.json ./
EXPOSE 8788
EXPOSE 8789
# Override config path: -e ROUTES_CONFIG=/config/routes.config.json -v /host/routes.config.json:/config/routes.config.json
CMD ["npm", "start"]
