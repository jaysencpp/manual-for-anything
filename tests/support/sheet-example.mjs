export function sheetExample() {
  const actions = [
    [{ id: 'lay', intent: 'place', v: 'place', k: 'stock', rel: 'floor' }],
    [{ id: 'cut', intent: 'cut', v: 'cut', k: 'stock', with: 'scissors', into: [
      { k: 'panel-a', label: '18 × 25 cm', size: [18, 25], origin: [0, 0], outline: [[0, 0], [12, 0], [18, 6], [18, 25], [0, 25]] },
      { k: 'panel-b', label: '18 × 25 cm', size: [18, 25], origin: [20, 0] },
    ] }],
    [{ id: 'put-a', intent: 'place', v: 'place', k: 'panel-a', rel: 'floor' }],
    [{ id: 'put-b', intent: 'place', v: 'place', k: 'panel-b', rel: 'on', to: 'panel-a' }],
    [{ id: 'join', intent: 'stitch', v: 'use', k: 'panel-b', to: 'panel-a', with: 'needle',
      path: [[1, 1], [1, 24]], otherPath: [[1, 1], [1, 24]] }],
  ]
  return { contractVersion: 2, title: 'Joined shaped panels', sub: 'Two parts', tag: 'Test', end: 'Panels joined', view: 'plan',
    objects: [{ k: 'stock', n: 'flat stock', cm: 40, b: [0, 0, 400, 300], part: { family: 'sheet', size: [40, 30, 0.1] }, measurements: { cm: { status: 'estimated', source: 'photo estimate' } } }],
    ideas: Array.from({ length: 3 }, () => ({ title: 'Joined panels', pitch: 'Shaped flat assembly' })), pick: 0,
    tools: [{ k: 'needle', use: 'needle' }, { k: 'scissors', use: 'scissors' }], joints: [], goals: [], finale: [],
    design: { purpose: 'A joined flat assembly', standard: 'Shaped panels', size: [18, 25, 0.1],
      parts: ['panel-a', 'panel-b'].map((k) => ({ k, from: 'stock', cm: 0, n: 1 })) },
    steps: actions.map((do_, i) => ({ t: ['Lay stock', 'Cut shaped panels', 'Place first panel', 'Align second panel', 'Join matching edges'][i], c: 'Follow the declared geometry', claims: do_.map((a) => a.id), do: do_ })),
  }
}

