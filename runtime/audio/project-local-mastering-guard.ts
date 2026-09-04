import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export interface ProjectLocalMasteringDuplicate {
  file: string;
  line: number;
  evidence: string[];
}

function literalText(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) return expression.getText();
  return null;
}

function resolvedCalls(source: ts.SourceFile): Array<{ text: string; offset: number }> {
  const childProcessCalls = new Set(["execFile", "execFileSync", "spawn", "spawnSync"]);
  const strings = new Map<string, string>();
  const arrays = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === "node:child_process"
      && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (["execFile", "execFileSync", "spawn", "spawnSync"].includes(imported)) {
          childProcessCalls.add(element.name.text);
        }
      }
    }
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const scalar = literalText(declaration.initializer);
      if (scalar !== null) strings.set(declaration.name.text, scalar);
      if (ts.isArrayLiteralExpression(declaration.initializer)) {
        const parts = declaration.initializer.elements.map((item) =>
          ts.isExpression(item) ? literalText(item) : null);
        if (parts.every((item): item is string => item !== null)) arrays.set(declaration.name.text, parts.join(" "));
      }
    }
  }
  const calls: Array<{ text: string; offset: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && childProcessCalls.has(node.expression.text)) {
        const commandArg = node.arguments[0];
        const argsArg = node.arguments[1];
        const command = commandArg
          ? literalText(commandArg) ?? (ts.isIdentifier(commandArg) ? strings.get(commandArg.text) ?? "" : "")
          : "";
        const args = argsArg
          ? ts.isArrayLiteralExpression(argsArg)
            ? argsArg.elements.map((item) => ts.isExpression(item) ? literalText(item) ?? item.getText() : "").join(" ")
            : ts.isIdentifier(argsArg) ? arrays.get(argsArg.text) ?? "" : argsArg.getText()
          : "";
        if (command === "ffmpeg") calls.push({ text: args, offset: node.getStart(source) });
      } else if (node.expression.getText(source) === "JSON.parse") {
        calls.push({ text: node.getText(source), offset: node.getStart(source) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function sourceFiles(rootDir: string): string[] {
  const projects = path.join(rootDir, "projects");
  if (!fs.existsSync(projects)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && target.split(path.sep).includes("06_review")) found.push(target);
    }
  };
  walk(projects);
  return found.sort((left, right) => left.localeCompare(right, "en"));
}

export function findProjectLocalLoudnormDuplicates(
  rootDir: string,
): ProjectLocalMasteringDuplicate[] {
  const issues: ProjectLocalMasteringDuplicate[] = [];
  for (const filePath of sourceFiles(path.resolve(rootDir))) {
    const source = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      /\.[cm]?jsx?$/.test(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
    );
    const calls = resolvedCalls(source);
    const ffmpegLoudnorm = calls.filter(({ text }) => /loudnorm=/.test(text));
    const pass1 = ffmpegLoudnorm.find(({ text }) => /print_format=json/.test(text));
    const pass2 = ffmpegLoudnorm.find(({ text }) => /measured_I=/.test(text) && /linear=true/.test(text));
    const parsesMeasurement = calls.some(({ text }) => /JSON\.parse\s*\(/.test(text));
    if (!pass1 || !pass2 || !parsesMeasurement) continue;
    const line = source.getLineAndCharacterOfPosition(pass1.offset).line + 1;
    issues.push({
      file: path.relative(rootDir, filePath).split(path.sep).join("/"),
      line,
      evidence: ["ffmpeg_loudnorm_pass1", "stderr_json_parse", "measured_linear_pass2"],
    });
  }
  return issues;
}
