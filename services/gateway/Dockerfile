FROM node:20-alpine

WORKDIR /app

RUN addgroup -S app && adduser -S -G app -u 10001 appuser

COPY package.json ./
RUN npm install --omit=dev && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY server.js ./
RUN chown -R appuser:app /app

EXPOSE 3000

USER appuser

CMD ["node", "server.js"]