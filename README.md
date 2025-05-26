# talk-around-town-backend

Talk Around Town (TAT) Backend

## Project Overview

A Node.js/Express backend API powering the Talk Around Town mobile application, designed to enhance parent-child communication across various contexts.

## Architecture

- Express.js server with RESTful API endpoints
- MySQL database for data persistence
- Firebase Cloud Messaging for push notifications
- JWT authentication for secure API access
- Google Cloud authentication for Firebase services

## Key Features

### Authentication System
- User registration and login
- JWT-based authentication with access and refresh tokens
- Password reset via email
- Device token management for iOS and Android

### Children Management
- Create and update child profiles
- Track children's information (nickname, date of birth)

### Location Services
- Geofencing functionality to detect user location
- Location-based notification triggers
- Custom location management

### Tips System
- Context-specific communication tips
- Random tip selection based on location type
- Notification delivery of relevant tips

### Notification System
- Firebase Cloud Messaging integration
- Platform-specific notification formatting (iOS/Android)
- Token validation and management

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `POST /api/auth/verify` - Verify JWT token
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - User logout
- `POST /api/auth/request-reset` - Request password reset
- `POST /api/auth/reset-password` - Reset password

### Child Management
- `GET /api/children` - Get user's children
- `POST /api/children` - Add new child
- `POST /api/updateChildren` - Update children's information

### Location Management
- `POST /api/addLocation` - Add new location
- `POST /api/locations` - Get user's saved locations
- `POST /api/tips` - Get tips for location type
- `POST /api` - Check current location against saved locations

## Technical Implementation

### Authentication Flow
- JWT tokens with access and refresh token strategy
- Token expiration and refresh mechanism
- Secure password handling with bcrypt

### Notification System
- FCM token validation
- Platform-specific payload formatting
- Error handling for invalid tokens

### Transaction Management
- MySQL transactions for data consistency
- Error handling and rollback mechanisms

## Setup Instructions

1. Clone the repository
2. Install dependencies with `npm install`
3. Configure environment variables in `.env` file:
   - Database connection details
   - JWT secrets
   - Firebase credentials
   - Email service credentials
4. Set up Firebase credentials in `key.json`
5. Start the server with `npm start`

## Environment Variables

- `PORT` - Server port
- `DB_HOST` - Database host
- `DB_USER` - Database user
- `DB_NAME` - Database name
- `DB_PASS` - Database password
- `JWT_SECRET` - Secret for JWT tokens
- `EMAIL_USER` - Email for sending notifications
- `EMAIL_PASS` - Email password
- `FRONTEND_URL` - URL for frontend application
- `OPENAI_API_KEY` - OpenAI API key (for AI-enhanced tips)

## Project Structure

- `routes` - API route handlers
- `config` - Configuration files
- `/` - Root directory with main application file
