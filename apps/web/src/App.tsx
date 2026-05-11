import { useEffect, useState } from 'react';

type WsStatus = 'connecting' | 'connected' | 'disconnected';

export default function App() {
  const [status, setStatus] = useState<WsStatus>('connecting');

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:5173/ws');
    ws.onopen = () => setStatus('connected');
    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('disconnected');
    return () => ws.close();
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50">
      <h1 className="text-4xl font-bold tracking-tight text-gray-900">Helm</h1>
      <p className="mt-4 font-mono text-sm text-gray-500">{status}</p>
    </div>
  );
}
