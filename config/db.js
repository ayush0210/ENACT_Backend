import mysql from 'mysql2/promise';
import 'dotenv/config';

// Create a connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10, // max idle connections, the default value is the same as `connectionLimit`
    idleTimeout: 60000, // idle connections timeout, in milliseconds, the default value 60000
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
});

// Test db connection
pool.query('SELECT 1 + 1 AS solution')
    .then(([rows, fields]) => {
        console.log('✅ Connected to MySQL DB');
    })
    .catch(err => {
        console.error('❌ MySQL connection error:', err);
    });

export default pool;