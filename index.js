import express from 'express';
import path from 'path';
import body from 'body-parser';
import cors from 'cors';
import location from './routes/location';
import 'dotenv/config';
import morgan from 'morgan';
import user from './routes/user';
import tips from './routes/tips';
import childrenRouter from './routes/children';
import sessionRoutes from './routes/sessions';
const app = express();
app.use(cors());

import cookieParser from 'cookie-parser';

require('dotenv').config({ path: path.join(__dirname, '.env') });
app.use(morgan('dev'));
app.use(cookieParser('session'));
app.use(body.json());
app.use(body.urlencoded({ extended: true }));
app.use('/endpoint', childrenRouter);
app.use('/endpoint/session', sessionRoutes);

import authroutes from './routes/auth';
app.use('/api/auth', authroutes);
app.use('/api/home', user);
app.use('/api/tips', tips);
app.get('/', async (req, res) => {
    return res.send('Active');
});

app.use('/endpoint', location);
const port = process.env.PORT || 1337;
app.listen(port, err => {
    if (err) console.log(err);
    else console.log(err || 'Listening on port ' + port);
});
