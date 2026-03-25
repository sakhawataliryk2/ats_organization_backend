// middleware.js
import { NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';

export async function middleware(request) {
    // Get token from cookies
    const token = request.cookies.get('token')?.value;

    // Define public paths that don't require authentication
    const publicPaths = [
        '/auth/login',
        '/auth/signup',
        '/api/auth/login',
        '/api/auth/signup',
        '/',
        '/about',
        '/contact'
    ];

    // Check if the requested path is a public path
    const isPublicPath = publicPaths.some(path =>
        request.nextUrl.pathname === path || request.nextUrl.pathname.startsWith(path)
    );

    // If path is public, allow access
    if (isPublicPath) {
        return NextResponse.next();
    }

    // If no token and trying to access protected route, redirect to login
    if (!token) {
        const url = new URL('/auth/login', request.url);
        url.searchParams.set('from', request.nextUrl.pathname);
        return NextResponse.redirect(url);
    }

    try {
        // Verify the token
        const SECRET_KEY = process.env.JWT_SECRET;
        const decoded = jwt.verify(token, SECRET_KEY);

        // Set user info in request headers for downstream use
        const requestHeaders = new Headers(request.headers);
        requestHeaders.set('x-user-id', decoded.userId);
        requestHeaders.set('x-user-email', decoded.email);
        requestHeaders.set('x-user-role', decoded.userType);

        // If token is valid, allow access with added headers
        return NextResponse.next({
            request: {
                headers: requestHeaders,
            },
        });
    } catch (error) {
        console.error('Token validation error:', error.message);

        // If token is invalid or expired, redirect to login
        const url = new URL('/auth/login', request.url);
        url.searchParams.set('from', request.nextUrl.pathname);
        return NextResponse.redirect(url);
    }
}

// Configure the paths that should trigger this middleware
export const config = {
    matcher: [
        /*
         * Match all paths except for:
         * 1. /api/auth routes (login, signup)
         * 2. /_next (Next.js internals)
         * 3. /static (public files)
         * 4. /favicon.ico, /robots.txt (common public files)
         * 5. /images (static images)
         */
        '/((?!_next|static|favicon.ico|robots.txt|images).*)',
    ],
};