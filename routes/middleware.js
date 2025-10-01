// middleware.js
const jwt = require('jsonwebtoken');

// Authenticate JWT middleware
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }
  
  const [bearer, token] = authHeader.split(' ');
  if (bearer !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Invalid authorization format' });
  }
console.log('AuthHeader:', authHeader);
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
    req.user = decoded;
    next();
console.log('Decoded User:', decoded);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        message: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// Authorize admin middleware
const authorizeAdmin = (req, res, next) => {
  // Check if user is authenticated
  if (!req.user) {
    return res.status(401).json({ message: 'User not authenticated' });
  }
  
  // Check if user has admin role
  if (!req.user.isAdmin) {
    return res.status(403).json({ message: 'Access forbidden: Admin privileges required' });
  }
  
  // User is admin, proceed
  next();
};

module.exports = { authenticateJWT, authorizeAdmin };
