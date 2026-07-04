FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN addgroup --system app && adduser --system --ingroup app app
USER app

EXPOSE 5000

CMD ["node", "server.js"]