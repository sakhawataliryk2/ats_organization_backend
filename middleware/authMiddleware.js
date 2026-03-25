const jwt = require('jsonwebtoken');
const User = require('../models/user');

// Middleware to verify JWT token
const verifyToken = (pool) => {
    const userModel = new User(pool);

    return async (req, res, next) => {
        try {
            // Get token from Authorization header
            const authHeader = req.headers.authorization;

            // Log token for debugging
            console.log('Auth header:', authHeader);

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({
                    success: false,
                    message: 'Access denied. No token provided.'
                });
            }

            const token = authHeader.split(' ')[1];

            // Log extracted token
            console.log('Extracted token:', token.substring(0, 20) + '...');

            // Verify the token
            try {
                const secretKey = process.env.JWT_SECRET || 'default_secret_key';
                console.log('JWT Secret Key first 5 chars:', secretKey.substring(0, 5) + '...');

                const decoded = jwt.verify(token, secretKey);
                console.log('Token decoded successfully:', decoded);

                // Find user by ID from token payload instead of token string
                const user = await userModel.findById(decoded.userId);

                if (!user) {
                    console.log('User not found with ID:', decoded.userId);
                    return res.status(401).json({
                        success: false,
                        message: 'Invalid or expired token'
                    });
                }

                // Check if user is active
                if (!user.status) {
                    return res.status(403).json({
                        success: false,
                        message: 'Your account has been deactivated'
                    });
                }

                // Add user info to the request
                req.user = {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    is_admin: user.is_admin
                };

                console.log('User found and authenticated:', req.user);
                next();
            } catch (jwtError) {
                console.error('JWT Verification error:', jwtError);
                return res.status(401).json({
                    success: false,
                    message: 'Invalid or expired token',
                    error: jwtError.message
                });
            }
        } catch (error) {
            if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
                console.error('Token error:', error.name, error.message);
                return res.status(401).json({
                    success: false,
                    message: 'Invalid or expired token'
                });
            }

            console.error('Error verifying token:', error);
            return res.status(500).json({
                success: false,
                message: 'Server error during authentication'
            });
        }
    };
};

// Middleware to check user role
const checkRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required'
            });
        }

        const hasRole = roles.includes(req.user.role);
        const isAdminByFlag = req.user.is_admin === true && roles.includes('admin');
        if (!hasRole && !isAdminByFlag) {
            return res.status(403).json({
                success: false,
                message: 'Access denied. Insufficient permissions.'
            });
        }
        next();
    };
};

module.exports = { verifyToken, checkRole };        