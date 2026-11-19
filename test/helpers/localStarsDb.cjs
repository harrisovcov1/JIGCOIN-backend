'use strict';
const {Pool} = require('pg');

// A private, throwaway PostgreSQL database. Never use the app's DATABASE_URL.
module.exports = async function localStarsDb(port) {
  const connection = {host: '127.0.0.1', port, user: process.env.USER || 'agent', ssl: false};
  const name = 'jigcoin_stars_test_' + process.pid;
  const admin = new Pool({...connection, database: 'postgres'});
  await admin.query('CREATE DATABASE ' + name);
  const pool = new Pool({...connection, database: name});
  const session = await pool.connect();
  return {
    query: (...args) => session.query(...args),
    exec: sql => session.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    async close() {
      session.release();
      await pool.end();
      try { await admin.query('DROP DATABASE ' + name); }
      finally { await admin.end(); }
    }
  };
};
