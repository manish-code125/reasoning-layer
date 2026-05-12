import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.REASONING_API_BASE ?? 'http://44.200.186.86/reasoning/api';

async function proxy(request: NextRequest, path: string[], method: string) {
  const url = `${API_BASE}/${path.join('/')}`;
  const body = method !== 'GET' ? await request.text() : undefined;

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: 'Upstream unreachable' }, { status: 502 });
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxy(req, path, 'GET');
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxy(req, path, 'POST');
}
