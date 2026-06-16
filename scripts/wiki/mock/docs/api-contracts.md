# API Contracts

## Authentication

All protected endpoints require an `Authorization: Bearer <token>` header.
Tokens are JWTs signed with RS256.

### POST /auth/login

Request:
```json
{ "email": "user@example.com", "password": "..." }
```

Response (200):
```json
{ "token": "...", "expiresAt": "2024-01-15T10:15:00Z" }
```

### GET /auth/me

Returns the current user profile. Requires authentication.

## Date: 2024-01-15
