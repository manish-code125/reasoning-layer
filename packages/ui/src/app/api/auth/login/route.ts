import { NextRequest, NextResponse } from 'next/server';

const USERNAME = process.env.PORTAL_USER ?? 'admin';
const PASSWORD = process.env.PORTAL_PASS ?? 'decide123';

export async function POST(request: NextRequest) {
  const { username, password } = await request.json();

  if (username === USERNAME && password === PASSWORD) {
    const response = NextResponse.json({ ok: true });
    response.cookies.set('auth-token', 'authenticated', {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      secure: process.env.PORTAL_SECURE_COOKIE === 'true',
    });
    return response;
  }

  return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
}
