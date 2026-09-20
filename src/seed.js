"use strict";

/** 初始数据：仅在建库文件缺失或损坏时写入 */

function seedData() {
  const now = new Date().toISOString();
  return {
    clocks: [
      {
        id: "clock_demo",
        code: "CLK-1890-07",
        escapementType: "瑞士杠杆式",
        balanceFrequency: "18000vph",
        targetDailyRateSeconds: 20,
        movementId: "movement_demo",
        note: "怀表机芯，走时偏快",
        createdAt: now
      }
    ],
    movements: [
      {
        id: "movement_demo",
        code: "MVT-1890-07",
        note: "怀表机芯档案",
        createdAt: now
      }
    ],
    movementArchives: [
      {
        id: "archive_demo_v1",
        movementId: "movement_demo",
        version: 1,
        dropAngle: 1.2,
        transmissionResistance: 18,
        amplitude: 280,
        status: "active",
        note: "出厂基线",
        createdAt: now,
        supersededAt: null
      }
    ],
    reviews: [],
    measurements: [],
    adjustments: [
      {
        id: "adjustment_demo",
        clockId: "clock_demo",
        currentDailyRateSeconds: 68,
        direction: "慢针方向",
        amount: "游丝快慢针向慢侧微调0.4格",
        note: "初次调校，先保守处理",
        createdAt: now
      }
    ],
    retests: [
      {
        id: "retest_demo",
        clockId: "clock_demo",
        adjustmentId: "adjustment_demo",
        testedAt: now,
        dailyRateSeconds: 31,
        amplitude: 248,
        qualified: false,
        note: "仍偏快，振幅尚可"
      }
    ]
  };
}

module.exports = { seedData };
