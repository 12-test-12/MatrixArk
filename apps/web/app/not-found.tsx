'use client';

import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Brand, Empty } from './ui';

export default function NotFound() {
  return <main className="missing-page">
    <Brand detail />
    <section className="card" aria-label="页面不存在">
      <Empty icon={Compass} title="找不到这个页面" description="请返回工作台，或检查链接地址。">
        <Link className="button primary" href="/">返回工作台</Link>
      </Empty>
    </section>
  </main>;
}
