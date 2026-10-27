import ts from 'typescript';
import { resolve, relative } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { repoRoot } from './paths.mjs';

const configPath = resolve(repoRoot, 'apps/server/tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(repoRoot, 'apps/server'));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const sources = program.getSourceFiles().filter(file => !file.isDeclarationFile && file.fileName.startsWith(resolve(repoRoot, 'apps/server/src')));
const location = node => {
  const file = node.getSourceFile();
  return `${relative(repoRoot, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};
function declaration(expression) {
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const found = symbol?.declarations?.find(node => ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node));
  if (!found || !found.getSourceFile().fileName.startsWith(repoRoot) || found.getSourceFile().fileName.includes('/node_modules/')) return null;
  return ts.isVariableDeclaration(found) ? found.initializer : found;
}
function inspect(root, visited = new Set()) {
  const sql = new Set(), functions = new Set();
  const walkFunction = node => {
    if (!node || visited.has(node)) return;
    visited.add(node);
    functions.add(location(node));
    const visit = current => {
      if (ts.isCallExpression(current)) {
        if (ts.isPropertyAccessExpression(current.expression)) {
          const method = current.expression.name.text;
          const owner = checker.typeToString(checker.getTypeAtLocation(current.expression.expression));
          const collection = /^(?:Readonly)?(?:Map|WeakMap|Set|WeakSet|Array)(?:<|Constructor\b)/.test(owner);
          if (!collection && ['prepare', 'from', 'insert', 'update', 'delete'].includes(method) && current.arguments.length) {
            const first = current.arguments[0];
            const target = first.getText().replace(/\s+/g, ' ').slice(0, 200);
            if (method === 'prepare' || !['Array', 'Object'].includes(current.expression.expression.getText())) sql.add(`${location(current)} ${method} ${target}`);
          }
        }
        for (const argument of current.arguments) if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) walkFunction(argument);
        const called = declaration(current.expression);
        if (called) walkFunction(called);
      }
      ts.forEachChild(current, visit);
    };
    ts.forEachChild(node, visit);
  };
  walkFunction(root);
  return { functions: [...functions].sort(), queryCandidates: [...sql].sort() };
}
const routes = [], modules = [];
for (const source of sources) {
  const sql = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === 'prepare') sql.push(location(node));
      const path = node.arguments[0];
      if (['get', 'post', 'put', 'patch', 'delete', 'use'].includes(method) && path && ts.isStringLiteral(path) && (path.text.startsWith('/') || path.text === '*') && node.arguments.length > 1) {
        const graph = inspect(node);
        routes.push({ method: method.toUpperCase(), path: path.text, source: location(node), ...graph });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  modules.push({ file: relative(repoRoot, source.fileName), rawSqlSites: sql });
}
const output = resolve(repoRoot, 'reports/cloudflare');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'route-coverage.json'), JSON.stringify({ generatedAt: new Date().toISOString(), limitation: 'Static call graph and unverified query candidates. Dynamic dispatch and route mount prefixes require correlation with SQL NDJSON.', routes, modules }, null, 2));
const csv = [['method', 'local_path', 'source', 'reachable_functions', 'query_candidates'], ...routes.map(route => [route.method, route.path, route.source, route.functions.length, route.queryCandidates.join('\n')])].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
await writeFile(resolve(output, 'route-coverage.csv'), csv);
console.log(JSON.stringify({ modules: modules.length, routes: routes.length, rawSqlSites: modules.reduce((sum, module) => sum + module.rawSqlSites.length, 0), output }));
