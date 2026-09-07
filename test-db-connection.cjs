const { Client } = require('pg')
const passwords = ['postgres', 'atzomqicwjufuxhfexxd', 'supabase', 'password', 'admin', 'InfinityCore', 'infinitycore', 'InfinityBank']
async function main() {
  for (const pw of passwords) {
    try {
      const c = new Client({
        host: 'aws-1-eu-west-1.pooler.supabase.com',
        port: 5432,
        user: 'postgres.atzomqicwjufuxhfexxd',
        database: 'postgres',
        password: pw,
        connectionTimeoutMillis: 5000
      })
      await c.connect()
      console.log('CONNECTED with password:', pw)
      await c.end()
      return
    } catch (e) {
      console.log('Failed with:', pw, '-', e.message.substring(0, 100))
    }
  }
  console.log('ALL PASSWORDS FAILED')
}
main()
