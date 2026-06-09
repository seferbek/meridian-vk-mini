# Meridian Backend

Node backend для стабильной авторизации Meridian.

## Переменные окружения

- `VK_APP_SECRET` — защищенный ключ мини-приложения VK. Нужен для проверки `sign`.
- `VK_APP_ID` — id мини-приложения VK. Если задан, backend сверяет его с `vk_app_id` из параметров запуска.
- `VK_LAUNCH_PARAMS_MAX_AGE_SECONDS` — опциональный лимит возраста `vk_ts` в секундах.
- `PORT` — порт сервера, по умолчанию `8787`.
- `CORS_ORIGIN` — разрешенный origin фронта. Для отладки можно `*`.
- `MERIDIAN_DB_PATH` — путь к JSON-хранилищу, по умолчанию `server/data/db.json`.

## Запуск

```bash
npm run backend
```

## Production

Backend можно запускать как обычный Node-сервис:

```bash
npm start
```

Или как Docker-контейнер:

```bash
docker build -t meridian-backend .
docker run -p 8787:8787 \
  -e VK_APP_SECRET=replace_with_vk_protected_key \
  -e VK_APP_ID=54520019 \
  -e CORS_ORIGIN=https://prod-app54520019-*.pages-ac.vk-apps.com \
  meridian-backend
```

Фронт должен получить публичный URL backend через:

```bash
VITE_API_BASE_URL=https://your-backend.example.com
```

## Авторизация VK Mini Apps

Backend не принимает отдельные регистрации и вход по email/password. Клиент передает подписанные параметры запуска VK, backend проверяет `sign` на каждом защищенном запросе и работает только с проверенным `vk_user_id`.

Без `VITE_API_BASE_URL` приложение подходит только для локальной разработки вне VK. Для VK-модерации и production публичный backend обязателен.
