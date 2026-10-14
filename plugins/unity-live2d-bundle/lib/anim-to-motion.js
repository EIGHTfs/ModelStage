// ============================================================================
// plugins/unity-live2d-bundle/lib/anim-to-motion.js —— Unity AnimationClip → motion3.json
//
// 适用对象：Unity 集成版 Live2D 资源包（包内只有 AnimationClip，没有现成 motion3.json）。
//   原生 Cubism 包不需要本文件（包内本来就有 motion3.json，直接抽取即可）。
//
// 一、Unity 这边动画数据长什么样（本样本实测 + 与 AssetStudio 结构定义逐条对齐）
//   AnimationClip.m_MuscleClip.m_Clip.data 里是三段之一：
//     · StreamedClip ：变曲线的关键帧流。data 是 **uint32 数组**，但里面混着 int 与 float32 的位模式：
//         帧 = { time: f32, keyCount: i32, keyCount × 关键帧 }
//         关键帧 = { index: i32, coeff: f32[4] }（coeff[2] = 出切线、coeff[3] = 值）
//       —— 关键帧是 5 个 32 位数，这是本文件最容易看错的地方（初看像「步长 5 的计数器规律」）。
//     · DenseClip    ：定频采样。m_SampleArray 长度 = m_FrameCount × m_CurveCount，
//                       取值下标 = frame × m_CurveCount + curve，时间 = m_BeginTime + frame / m_SampleRate。
//     · ConstantClip ：恒定曲线的值，数组顺序就是绑定顺序的后半段。
//   三段的**曲线总数**等于 m_ClipBindingConstant.genericBindings.length，
//   且满足 streamed + dense + constant = bindings（本样本 34 个 clip 全部成立，已断言）。
//
// 二、曲线绑定到哪个参数
//   genericBindings[i] = { path: u32, attribute: u32, typeID, customType, ... }，两个都是 **CRC32 哈希**。
//   实测 crc32("Value") = 3702945584 = 本样本所有绑定的 attribute ⇒ 曲线写的是组件的 Value 字段；
//   path 哈希即「Cubism 参数名」（如 ParamAngleX）——用候选名单（moc3 里的参数/部件名 + 物理文件里的名字）
//   逐个算 CRC32 反查，查不到就跳过该曲线并在统计里报数（绝不猜名字）。
//
// 三、输出 motion3.json 的取值与计数
//   Segments 采用线性段的三元组排布：首点 (t0, v0)，其后每个关键帧写成 (0, t, v)，
//   末尾补一个 0 作为最后一段的类型占位 —— 这是运行时（Cubism 的 parse）实际的遍历方式：
//     第 0 次迭代取 (Segments[0], Segments[1]) 作为首点；之后每次读 Segments[l] 当段类型，
//     线性段再吃掉 (t, v) 两个值 ⇒ 数组形态 = [t0, v0, 0, t1, v1, 0, ...]。
//   Meta：Duration 取 m_MuscleClip.m_StopTime（实测 = 动作时长），Fps 取 m_SampleRate，
//         CurveCount/TotalSegmentCount/TotalPointCount 按实际产出统计。
//
// 挂载：globalThis.__ULB__.animToMotion
// ============================================================================

'use strict';

{
  const root = globalThis;   // 原 IIFE 的 root 引用（脚本级裸块内保持同名）
  const NS = (root.__ULB__ = root.__ULB__ || {});
  const B = NS.bytes;

  const F32 = new Float32Array(1);
  const I32 = new Int32Array(F32.buffer);
  const U32 = new Uint32Array(F32.buffer);

  /** uint32 位模式 → float（Unity 的流里 int 与 float 混用同一片 uint32 数据） */
  function bitsToFloat(bits) {
    U32[0] = bits >>> 0;
    return F32[0];
  }
  /** f32 → int32 位模式 */
  function floatToBits(f) {
    F32[0] = f;
    return I32[0];
  }
  /** uint32 位模式 → int32 */
  function bitsToInt(bits) {
    U32[0] = bits >>> 0;
    return I32[0];
  }

  /**
   * 解 StreamedClip。
   * @param {Array<number>} data uint32 数组（data 字段原样）
   * @returns {{frames:Array<{time:number,keys:Array<{index:number,value:number,outSlope:number,inSlope:number}>}>, curveFrames:Map<number,Array<{t:number,v:number}>>}}
   */
  function decodeStreamedClip(data, opts) {
    const frames = [];
    let i = 0;
    let guard = 0;
    while (i + 1 < data.length) {
      if (++guard > 1e6) throw NS.errors.fail('ULB_ERR_STREAMED_CLIP_INVALID', 'StreamedClip 帧数异常，疑似数据布局不符');
      const time = bitsToFloat(data[i]);
      const numKeys = bitsToInt(data[i + 1]);
      if (numKeys < 0 || numKeys > 4096) {
        throw NS.errors.fail('ULB_ERR_STREAMED_CLIP_INVALID', `StreamedClip 帧的关键帧数非法：${numKeys}（偏移 ${i}）`);
      }
      i += 2;
      const keys = [];
      for (let k = 0; k < numKeys; k++) {
        if (i + 4 >= data.length + 1) throw NS.errors.fail('ULB_ERR_STREAMED_CLIP_INVALID', 'StreamedClip 数据在关键帧中间结束');
        const index = bitsToInt(data[i]);
        const c0 = bitsToFloat(data[i + 1]);
        const c1 = bitsToFloat(data[i + 2]);
        const outSlope = bitsToFloat(data[i + 3]);
        const value = bitsToFloat(data[i + 4]);
        keys.push({ index, coeff: [c0, c1, outSlope, value], value, outSlope, inSlope: 0 });
        i += 5;
      }
      frames.push({ time, keys });
    }
    // 按曲线整理：关键帧只在部分帧出现（稀疏），这里按出现顺序收集并**按时间区间过滤**。
    //   哨兵帧：首帧 time = -FLT_MAX、末帧 time = +Inf（都是有限/无穷的极端值，不是真时间轴上的帧），
    //   它们只用于给相邻帧算切线。区间取 [m_StartTime - 1ms, m_StopTime + 1ms]，
    //   既剔除哨兵帧，又保留真正的起始帧（time = 0）。
    const t0 = (opts && opts.timeRange ? opts.timeRange[0] : 0);
    const t1 = (opts && opts.timeRange ? opts.timeRange[1] : Number.MAX_VALUE);
    const inRange = (t) => Number.isFinite(t) && t >= t0 - 1e-3 && t <= t1 + 1e-3;
    const curveFrames = new Map();
    for (const fr of frames) {
      if (!inRange(fr.time)) continue;
      for (const k of fr.keys) {
        if (!curveFrames.has(k.index)) curveFrames.set(k.index, []);
        curveFrames.get(k.index).push({ t: fr.time, v: k.value });
      }
    }
    return { frames, curveFrames };
  }

  /** 解 DenseClip → 每条曲线的采样点 */
  function decodeDenseClip(dense) {
    const out = new Map();
    const count = Number(dense.m_CurveCount || 0);
    const frames = Number(dense.m_FrameCount || 0);
    const sample = dense.m_SampleArray || [];
    if (!count || !frames) return out;
    const rate = Number(dense.m_SampleRate) || 60;
    const begin = Number(dense.m_BeginTime) || 0;
    for (let c = 0; c < count; c++) {
      const pts = [];
      for (let f = 0; f < frames; f++) {
        const idx = f * count + c;
        if (idx >= sample.length) break;
        pts.push({ t: begin + f / rate, v: Number(sample[idx]) });
      }
      out.set(c, pts);
    }
    return out;
  }

  /**
   * 用候选名单反查 CRC32 哈希 → 名字。
   *
   * 路径前缀：本样本实测绑定路径是 **`Parameters/<参数名>`**（416/416 命中；不带前缀一个都不命中），
   *   这是 Cubism 的 Unity 集成对「模型参数」的路径约定。故同时登记「带前缀」与「裸名」两种形态，
   *   命中后统一返回**裸参数名**——运行时的 motion3 曲线用参数 ID 查找，ID 就是裸名。
   *
   * @param {string[]} candidates 裸名列表（moc3 里的参数/部件名等）
   * @param {string[]} [prefixes] 路径前缀（默认 ['Parameters/', '']）
   */
  function buildHashLookup(candidates, prefixes) {
    const pre = prefixes || ['Parameters/', ''];
    const map = new Map();
    for (const name of candidates) {
      for (const p of pre) {
        const h = B.crc32(p + name);
        if (!map.has(h)) map.set(h, name);
      }
    }
    return map;
  }

  /**
   * 把一条曲线的关键帧转成 motion3 的 Segments（全线性段）。
   *
   * 形态（与原生 motion3 完全一致，实测原生 idle.motion3.json 逐条核对）：
   *   [t0, v0, 0, t1, v1, 0, t2, v2, …]
   *   —— 开头是首点 (t0,v0)，其后**每段**是三元组 (段类型, t, v)：0=线性，1=贝塞尔，2/3=阶跃。
   *   运行时按「先吃 2 个，再按段类型吃 3/7/3/3 个」循环消费（index.min.js 的 ee.parse），
   *   因此**末尾不能有任何多余值**：多一个 0 就会被当成"再来一段线性"而多消费 3 个值，
   *   越过预分配的 segments 数组（实测报 TypeError: Cannot set properties of undefined (setting 'basePointIndex')）。
   *   长度恒为 2 + 3×(点数-1) = 3×点数 - 1。
   *
   * 只做**一一对应**的搬运：不插值、不抽稀、不改值 —— Unity 的关键帧原样进 motion3。
   */
  /**
   * 按**运行时的真实消费过程**走一遍 Segments，返回它会产生多少段、多少个点。
   *
   *   运行时（index.min.js 的 ee.parse）先按 Meta.TotalSegmentCount **预分配** segments 数组：
   *     this._motionData.segments = Array.from({length: getMotionTotalSegmentCount()})
   *   然后每条曲线每消费一段就写一个 segments[o] 并 o++。所以：
   *     · Meta.TotalSegmentCount 必须 ≥ Σ(每曲线的消费轮数)，否则写到数组外 —— 运行时报
   *       TypeError: Cannot set properties of undefined (setting 'basePointIndex')（实测就是这个）。
   *     · 原生导出件（abeikelongbi_3/motions/*.motion3.json 实测 14 个）一律 = Σ轮数 + 1，
   *       这里跟它保持一致（多留 1 个）。
   *   轮数规则：首轮先读首点 (t,v) 吃掉 2 个值，**同一轮**再读一个段类型并按类型吃掉 3（线性/阶跃）
   *   或 7（贝塞尔）个值；类型位置读到 undefined 时这一轮不消费任何值（单点曲线就是这种情况）。
   */
  function runtimeLayout(seg) {
    let l = 0;
    let iterations = 0;
    let guard = 0;
    while (l < seg.length && guard++ < seg.length + 4) {
      iterations++;
      if (l === 0) l += 2;
      const t = seg[l];
      if (t === 1) l += 7;
      else if (t === 0 || t === 2 || t === 3) l += 3;
      // 其它类型（含 undefined）不消费 —— 与运行时 switch 无匹配分支的行为一致
    }
    return { iterations, points: iterations + 1, ended: l };
  }

  function consumesExactly(seg) {
    const r = runtimeLayout(seg);
    return r.ended === seg.length;
  }

  function toLinearSegments(points) {
    const seg = [];
    let count = 0;
    for (const p of points) {
      if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) continue;
      if (count === 0) seg.push(p.t, p.v);
      else seg.push(0, p.t, p.v);   // 0 = 线性段
      count++;
    }
    return { segments: seg, points: count };
  }

  /**
   * 把一个 AnimationClip 转成 motion3.json 对象。
   * @param {object} sf serialized 解析结果
   * @param {object} clipObj AnimationClip 对象条目
   * @param {object} opts { hashLookup:Map, loop:boolean, fadeIn:number, fadeOut:number, paramWhitelist?:Set, log?:function }
   *   paramWhitelist：**moc3 参数表**里的参数 Id 集合（来自 Cubism Core 的 parameters.ids）。
   *     名字靠字符串表反查出来的结果里可能混进部件名/绘制名之类"不是参数"的名字，
   *     那种 Id 写进 motion3 后运行时查不到参数对象而抛异常 —— 故这里以参数表为准，
   *     只输出 Id 确实在表内的曲线，其余计入 skippedNotParameter（如实报数，不猜）。
   * @returns {{json:object, stats:object}}
   */
  /** 读 clip 头部数据并校验「曲线数 = 绑定数」，返回各数据源与计数。 */
  function readClipSources(f) {
    const data = f.m_MuscleClip.m_Clip.data;
    const streamed = data.m_StreamedClip;
    const dense = data.m_DenseClip;
    const constant = data.m_ConstantClip || { data: [] };
    const bindings = f.m_ClipBindingConstant.genericBindings || [];
    const streamedCurveCount = Number(streamed.curveCount || 0);
    const denseCurveCount = Number(dense.m_CurveCount || 0);
    const constantData = (constant.data || []).map(Number);
    if (streamedCurveCount + denseCurveCount + constantData.length !== bindings.length) {
      throw NS.errors.fail('ULB_ERR_CURVE_BINDING_MISMATCH', `曲线数与绑定数不一致：streamed ${streamedCurveCount}`
        + ` + dense ${denseCurveCount} + constant ${constantData.length} != bindings ${bindings.length}`);
    }
    return { streamed, dense, bindings, streamedCurveCount, denseCurveCount, constantData };
  }

  /** 曲线统计初值（口径：分母 = 绑定条数，= 每条绑定最多一条曲线）。 */
  function createCurveStats(f, src) {
    return {
      name: f.m_Name,
      duration: Number(f.m_MuscleClip.m_StopTime || 0),
      startTime: Number(f.m_MuscleClip.m_StartTime || 0),
      fps: Number(f.m_SampleRate || 0),
      wrapMode: Number(f.m_WrapMode || 0),
      bindings: src.bindings.length,
      streamedCurves: src.streamedCurveCount,
      denseCurves: src.denseCurveCount,
      constantCurves: src.constantData.length,
      curvesTotal: 0,
      emitted: 0,
      skippedUnknownBinding: 0,   // 路径哈希反查不到名字
      skippedNotParameter: 0,     // 反查到名字但不在 moc3 参数表里
      skippedEmpty: 0,
      expandedSinglePoint: 0,   // 单点曲线补成两点（否则运行时求值每帧抛 undefined.time）
      invalidSegments: 0,   // 按运行时消费规则会越界的曲线数（必须为 0）
      totalPoints: 0,
      totalSegments: 0,
      unknownHashes: [],
      notParameterIds: [],
    };
  }

  /**
   * 逐条绑定取点：按索引分流到 streamed / dense / constant 三个数据源，
   *   再统一排序、单点补两点、切成线性段，并累加统计。
   * @returns {Array<{Target:string, Id:string, Segments:number[]}>} 曲线数组
   */
  function collectCurves(f, src, decoded, denseMap, hashLookup, whitelist, stats) {
    const { bindings, streamedCurveCount, denseCurveCount, constantData } = src;
    const curves = [];
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i];
      stats.curvesTotal++;
      const name = hashLookup.get(b.path >>> 0) || null;
      if (!name) {
        stats.skippedUnknownBinding++;
        if (stats.unknownHashes.length < 12) stats.unknownHashes.push(b.path >>> 0);
        continue;
      }
      if (whitelist && !whitelist.has(name)) {
        // 名字是从字符串表解出来的，但不在这份 moc3 的参数表里 —— 运行时不认识，跳过并计入
        stats.skippedNotParameter++;
        if (stats.notParameterIds.length < 12) stats.notParameterIds.push(name);
        continue;
      }
      let points;
      if (i < streamedCurveCount) {
        points = decoded.curveFrames.get(i) || [];
      } else if (i < streamedCurveCount + denseCurveCount) {
        points = denseMap.get(i - streamedCurveCount) || [];
      } else {
        const v = constantData[i - streamedCurveCount - denseCurveCount];
        points = [{ t: 0, v: Number(v) }];
      }
      if (!points.length) { stats.skippedEmpty++; continue; }
      points.sort((a, b2) => a.t - b2.t);
      // 单点曲线补成两点：运行时的求值器对**每个段**都要取"后继点"
      //   （points[basePointIndex + 1]）；只有 1 个点的曲线其唯一段没有后继点，
      //   求值时就抛 Cannot read properties of undefined (reading 'time')——实测
      //   aimierbeierding_2 有 129 条这样的曲线（来自 m_ConstantClip 的常量），横跨全部 14 个动作。
      //   补成 (t0,v) → (StopTime,v)：语义等价（该参数在这段时长里保持常量），运行时可正常求值。
      if (points.length === 1) {
        const t0p = points[0].t;
        const endT = stats.duration > t0p ? stats.duration : t0p + 1e-3;
        points.push({ t: endT, v: points[0].v });
        stats.expandedSinglePoint++;
      }
      const built = toLinearSegments(points);
      // 结构自检：按运行时消费规则走一遍，必须**正好**停在数组末尾（末尾多一个值会被当成新段而多消费）
      const layout = runtimeLayout(built.segments);
      if (layout.ended !== built.segments.length) stats.invalidSegments++;
      curves.push({ Target: 'Parameter', Id: name, Segments: built.segments });
      stats.emitted++;
      // 计数按**运行时口径**：段数 = 消费轮数（Meta.TotalSegmentCount 要为它预留空间），
      //   点数 = 轮数 + 1（运行时每条曲线的 points 数组实际长度）
      stats.totalPoints += layout.points;
      stats.totalSegments += layout.iterations;
    }
    return curves;
  }

  function clipToMotion(sf, clipObj, opts) {
    const o = opts || {};
    const f = NS.typetree.readObject(sf, clipObj);
    const src = readClipSources(f);
    const dense = src.dense;
    const decoded = decodeStreamedClip(src.streamed ? src.streamed.data || [] : [], {
      timeRange: [Number(f.m_MuscleClip.m_StartTime || 0), Number(f.m_MuscleClip.m_StopTime || 0)],
    });
    const denseMap = decodeDenseClip(dense);
    const hashLookup = o.hashLookup || new Map();
    // 参数白名单：只认 moc3 参数表里的 Id（未提供时退化为不校验，并记录这一事实）
    const whitelist = o.paramWhitelist instanceof Set ? o.paramWhitelist : null;
    const stats = createCurveStats(f, src);
    const curves = collectCurves(f, src, decoded, denseMap, hashLookup, whitelist, stats);

    const duration = stats.duration || (stats.fps ? (dense.m_FrameCount || 0) / stats.fps : 0);
    const json = {
      Version: 3,
      Meta: {
        Duration: Number(duration.toFixed(6)),
        Loop: !!o.loop,
        AreBeziersRestricted: false,
        CurveCount: curves.length,
        // +1：运行时按这个数预分配 segments 数组，原生导出件也一律多留 1（实测 14 个原生 motion3 全部如此）
        TotalSegmentCount: stats.totalSegments + 1,
        TotalPointCount: stats.totalPoints,
        Fps: stats.fps,
        FadeInTime: o.fadeIn === undefined ? 0.5 : o.fadeIn,
        FadeOutTime: o.fadeOut === undefined ? 0.5 : o.fadeOut,
      },
      Curves: curves,
    };
    if (o.log) o.log(f.m_Name, stats);
    return { json, stats };
  }

  /**
   * 批量转换一个资源包里的全部 AnimationClip。
   * @param {object} sf
   * @param {string[]} nameCandidates CRC32 候选名单（参数名/部件名）
   * @param {object} opts { isLoop(name):boolean, fadeIn, fadeOut, paramWhitelist?:Set, log }
   * @returns {{motions:Array, hashLookup:Map, dropped:Array}}
   *   motions：过滤后仍有曲线的动作；dropped：过滤后曲线为空而被丢弃的动作（含各自统计，便于报数）
   */
  function clipsToMotions(sf, nameCandidates, opts) {
    const o = opts || {};
    const hashLookup = buildHashLookup(nameCandidates || []);
    const out = [];
    const dropped = [];
    for (const obj of NS.serialized.byClass(sf, 74)) {
      const probe = NS.typetree.readObject(sf, obj);
      const name = probe.m_Name;
      const { json, stats } = clipToMotion(sf, obj, {
        hashLookup,
        paramWhitelist: o.paramWhitelist,
        loop: o.isLoop ? !!o.isLoop(name) : false,
        fadeIn: o.fadeIn,
        fadeOut: o.fadeOut,
      });
      // 过滤后没有任何曲线的动作**不产出**：白名单（moc3 参数表）会剔掉本模型不存在的参数，
      //   若某动作的曲线全被剔掉，它就是个空动作——留在列表里只会是一个点开即失败/无效果的条目。
      //   如实计入 dropped（含该动作自己的统计），由调用方报数。
      if (!json.Curves.length) {
        dropped.push({ name, stats });
        if (o.log) o.log(name, stats);
        continue;
      }
      out.push({ name, json, stats });
      if (o.log) o.log(name, stats);
    }
    return { motions: out, hashLookup, dropped };
  }

  NS.animToMotion = {
    decodeStreamedClip, decodeDenseClip, clipToMotion, clipsToMotions,
    buildHashLookup, toLinearSegments, bitsToFloat, floatToBits, bitsToInt,
  };
}
