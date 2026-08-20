import { createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState(['Fiber', 'Diff', 'Hooks']);

  useEffect(() => {
    document.title = 'count: ' + count;
    return () => {
      document.title = 'Mini React';
    };
  }, [count]);

  return createElement(
    'div',
    { className: 'app' },
    createElement('h1', null, 'Mini React'),
    createElement(
      'p',
      { className: 'hint' },
      'Fiber + commit + useState + keyed list',
    ),
    createElement('p', null, 'count: ' + count),
    createElement(
      'div',
      { className: 'row' },
      createElement(
        'button',
        { onClick: () => setCount((value) => value + 1) },
        '+1',
      ),
      createElement(
        'button',
        {
          onClick: () =>
            setItems((list) => list.concat('item-' + list.length)),
        },
        'add',
      ),
      createElement(
        'button',
        { onClick: () => setItems((list) => list.slice().reverse()) },
        'reverse',
      ),
    ),
    createElement(
      'ul',
      null,
      ...items.map((item) => createElement('li', { key: item }, item)),
    ),
  );
}

const container = document.getElementById('root');
if (container == null) {
  throw new Error('Root container #root was not found');
}

createRoot(container).render(createElement(App, null));
