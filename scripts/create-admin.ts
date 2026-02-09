/**
 * Admin 계정 생성 스크립트
 *
 * Usage: npx tsx scripts/create-admin.ts <email> <password>
 *
 * 환경변수 필요:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

dotenv.config();

async function main() {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error('Usage: npx tsx scripts/create-admin.ts <email> <password>');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const passwordHash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from('users')
    .insert({ email, password_hash: passwordHash, role: 'admin' })
    .select('id, email, role')
    .single();

  if (error) {
    if (error.code === '23505') {
      console.error(`Error: Email "${email}" already exists`);
    } else {
      console.error('Error creating admin:', error.message);
    }
    process.exit(1);
  }

  console.log('Admin account created:');
  console.log(`  ID:    ${data.id}`);
  console.log(`  Email: ${data.email}`);
  console.log(`  Role:  ${data.role}`);
}

main();
