# Architecture Notes

## Overview

This project uses a layered architecture:
- **API layer**: Express.js routes under `src/routes/`
- **Service layer**: Business logic under `src/services/`
- **Data layer**: Repository pattern under `src/repositories/`

The AuthService is responsible for JWT token generation and validation.
Tokens expire after 15 minutes by default.

## Key Decisions

- We use PostgreSQL as the primary database.
- Redis is used for session caching.
- The payment flow goes through Stripe exclusively.

## Date: 2024-01-15
