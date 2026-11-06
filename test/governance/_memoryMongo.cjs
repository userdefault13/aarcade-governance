/**
 * In-memory stand-in for lib/mongodb.cjs, enough for lib/governance/store.cjs: equality and
 * $in / range filters, inclusion or exclusion projections, sort / skip / limit, upserts and
 * bulkWrite. Install before requiring anything under lib/governance.
 */
const path = require('node:path');

function fieldMatches(value, cond) {
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$in') return arg.includes(value);
      if (op === '$gt') return value > arg;
      if (op === '$gte') return value >= arg;
      if (op === '$lt') return value < arg;
      if (op === '$lte') return value <= arg;
      if (op === '$ne') return value !== arg;
      if (op === '$exists') return (value !== undefined) === Boolean(arg);
      throw new Error(`memoryMongo: unsupported operator ${op}`);
    });
  }
  return value === cond;
}
const matches = (doc, filter = {}) => Object.entries(filter).every(([k, cond]) => fieldMatches(doc[k], cond));

function project(doc, projection) {
  if (!projection) return doc;
  const entries = Object.entries(projection);
  const include = entries.filter(([k, v]) => v && k !== '_id').map(([k]) => k);
  let out;
  if (include.length) {
    out = Object.fromEntries(include.filter((k) => k in doc).map((k) => [k, doc[k]]));
    if (projection._id !== 0) out._id = doc._id;
  } else {
    out = { ...doc };
    for (const [k, v] of entries) if (!v) delete out[k];
  }
  return out;
}

function createMemoryMongo() {
  const tables = new Map();
  function collection(name) {
    if (!tables.has(name)) tables.set(name, []);
    const rows = tables.get(name);
    let nextId = 1;
    const upsertOne = (filter, $set, upsert) => {
      const hit = rows.find((d) => matches(d, filter));
      if (hit) Object.assign(hit, structuredClone($set));
      else if (upsert) rows.push(structuredClone({ _id: `${name}:${nextId++}`, ...filter, ...$set }));
      return hit ? 1 : 0;
    };
    return {
      collectionName: name,
      rows,
      async findOne(filter, opts) {
        const hit = rows.find((d) => matches(d, filter));
        return hit ? project(structuredClone(hit), opts?.projection) : null;
      },
      find(filter, opts) {
        let out = rows.filter((d) => matches(d, filter)).map((d) => project(structuredClone(d), opts?.projection));
        const cursor = {
          sort(spec) {
            const keys = Object.entries(spec);
            out.sort((a, b) => {
              for (const [k, dir] of keys) if (a[k] !== b[k]) return (a[k] > b[k] ? 1 : -1) * dir;
              return 0;
            });
            return cursor;
          },
          skip(n) {
            out = out.slice(n);
            return cursor;
          },
          limit(n) {
            out = out.slice(0, n);
            return cursor;
          },
          toArray: async () => out,
        };
        return cursor;
      },
      async countDocuments(filter) {
        return rows.filter((d) => matches(d, filter)).length;
      },
      async insertOne(doc) {
        rows.push(structuredClone({ _id: `${name}:${nextId++}`, ...doc }));
      },
      async updateOne(filter, { $set }, opts) {
        return { matchedCount: upsertOne(filter, $set, opts?.upsert) };
      },
      async bulkWrite(ops) {
        let matched = 0;
        for (const op of ops) {
          if (!op.updateOne) throw new Error('memoryMongo: bulkWrite supports updateOne only');
          matched += upsertOne(op.updateOne.filter, op.updateOne.update.$set, op.updateOne.upsert);
        }
        return { matchedCount: matched };
      },
      async createIndex() {
        return 'ok';
      },
    };
  }
  const cols = new Map();
  const get = (name) => {
    if (!cols.has(name)) cols.set(name, collection(name));
    return cols.get(name);
  };
  return { collection: get };
}

/** Replace lib/mongodb.cjs in the require cache; returns the in-memory db. */
function installMemoryMongo() {
  const mem = createMemoryMongo();
  const mongodbPath = path.join(__dirname, '../../lib/mongodb.cjs');
  require.cache[mongodbPath] = {
    id: mongodbPath,
    filename: mongodbPath,
    loaded: true,
    exports: {
      connect: async () => ({ db: () => ({ collection: mem.collection }) }),
      getAdminUsersCollection: async () => mem.collection('admin_users'),
    },
  };
  return mem;
}

module.exports = { installMemoryMongo, createMemoryMongo };
