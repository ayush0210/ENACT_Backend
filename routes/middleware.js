const jwt = require('jsonwebtoken');

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  const [bearer, jwtToken] = authHeader.split(' ');

  if (bearer !== 'Bearer' || !jwtToken) {
    return res.status(401).json({ message: 'Invalid authorization token' });
  }

  try {
    const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET || 'talkaroundtownsecret');
    req.user = decoded; // Attach the decoded token to the request object
    next() // Proceed to the next middleware or route handler
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

module.exports = authenticateJWT;