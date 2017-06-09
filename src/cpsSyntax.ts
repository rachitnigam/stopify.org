import {NodePath, VisitNode, Visitor} from 'babel-traverse';
import * as t from 'babel-types';
import {administrative,
  call,
  apply,
  directApply,
  flatBodyStatement,
  letExpression,
  transformed,
  ReturnStatement,
  union
} from './helpers';

import {
  AExpr, BExpr, CExpr, Node, BFun, BAdminFun, BAtom, BOp2, BOp1, BLOp,
  BAssign, BObj, BArrayLit, BGet, BIncrDecr, BUpdate, BSeq, BThis, BNew,
  CApp, CCallApp, CApplyApp, CAdminApp, ITE, CLet, FreeVars, fvs, withFVs
} from './cexpr';
import {CPS, ret} from './cpsMonad';
import {raiseFuns} from './liftFunExprs';

const undefExpr: AExpr = t.identifier("undefined");

function cpsExprList(exprs: (t.Expression | t.SpreadElement)[],
  k: (args: (AExpr | t.SpreadElement)[]) => CPS<CExpr,CExpr>,
  ek: (arg: AExpr) => CPS<CExpr,CExpr>,
  path: NodePath<t.Node>): CPS<CExpr,CExpr> {
    if (exprs.length === 0) {
      return k([]);
    }
    else {
      const [ hd, ...tl ] = exprs;
      if (t.isExpression(hd)) {
        return cpsExpr(hd,
          (v: AExpr) => cpsExprList(tl,
            (vs: AExpr[]) => k([v, ...vs]),
            ek,
            path), ek, path);
      } else {
        return cpsExprList(tl,
          (vs: AExpr[]) => k([hd, ...vs]),
          ek,
          path);
      }
    }
  }

function cpsObjMembers(mems: t.ObjectMember[],
  k: (args: AExpr[][]) => CPS<CExpr,CExpr>,
  ek: (arg: AExpr) => CPS<CExpr,CExpr>,
  path: NodePath<t.Node>): CPS<CExpr,CExpr> {
    if (mems.length === 0) {
      return k([]);
    }
    else {
      const [ hd, ...tl ] = mems;
      return cpsExpr(hd.key,
        (id: AExpr) => cpsExpr(hd.value,
          (v: AExpr) => cpsObjMembers(tl,
            (vs: AExpr[][]) => k([[id,v], ...vs]),
            ek,
            path), ek, path), ek, path);
    }
  }

function cpsExpr(expr: t.Expression,
  k: (arg: AExpr) => CPS<CExpr,CExpr>,
  ek: (arg: AExpr) => CPS<CExpr,CExpr>,
  path: NodePath<t.Node>): CPS<CExpr,CExpr> {
    if (expr === null) {
      return k(t.nullLiteral());
    }
    switch (expr.type) {
      case 'Identifier':
      case 'BooleanLiteral':
      case 'NumericLiteral':
      case 'StringLiteral':
      case 'NullLiteral':
      case 'RegExpLiteral':
      case 'TemplateLiteral':
        return k(expr);
      case 'ArrayExpression':
        return cpsExprList(expr.elements, (args: AExpr[]) => {
          const arr = path.scope.generateUidIdentifier('arr');
          return k(arr).map(c => new CLet('const', arr, new BArrayLit(args), c));
        }, ek, path);
      case "AssignmentExpression":
        const assign = path.scope.generateUidIdentifier('assign');
        return cpsExpr(expr.right, r =>
          k(assign).map(c =>
            new CLet('const', assign, new BAssign(expr.operator, withFVs(expr.left), r),
              c)), ek, path);
      case 'BinaryExpression':
        let bop = path.scope.generateUidIdentifier('bop');
        return cpsExpr(expr.left, l =>
          cpsExpr(expr.right, r =>
            k(bop).map(c => new CLet('const', bop, new BOp2(expr.operator, l, r), c)),
            ek, path), ek, path);
      case 'LogicalExpression':
        if (expr.operator === '&&') {
          const if_cont = path.scope.generateUidIdentifier('if_cont');
          return k(if_cont).bind(c =>
            cpsExpr(expr.left, l =>
              cpsExpr(expr.right, r =>
                ret<CExpr,CExpr>(new CAdminApp(if_cont, [r])),
                ek, path).map(r =>
                  new CLet('const', if_cont,
                    new BAdminFun(undefined, [if_cont], c),
                    new ITE(l,
                      r,
                      new CAdminApp(if_cont, [t.booleanLiteral(false)])))),
              ek, path));
        } else {
          const if_cont = path.scope.generateUidIdentifier('if_cont');
          return k(if_cont).bind(c =>
            cpsExpr(expr.left, l =>
              cpsExpr(expr.right, r =>
                ret<CExpr,CExpr>(new CAdminApp(if_cont, [r])),
                ek, path).map(r =>
                  new CLet('const', if_cont,
                    new BAdminFun(undefined, [if_cont], c),
                    new ITE(l,
                      new CAdminApp(if_cont, [l]),
                      r))),
              ek, path));
        }
      case 'ConditionalExpression':
        return cpsExpr(expr.test, tst => {
          const cont = path.scope.generateUidIdentifier('cond_cont');
          return k(cont).bind(cond_cont =>
            cpsExpr(expr.consequent, v => ret<CExpr,CExpr>(new CAdminApp(cont, [v])), ek, path)
            .bind(consequent =>
              cpsExpr(expr.alternate, v => ret<CExpr,CExpr>(new CAdminApp(cont, [v])), ek, path)
              .map(alternate =>
                new CLet('const', cont, new BAdminFun(undefined, [cont], cond_cont),
                  new ITE(tst, consequent, alternate)))));
        }, ek, path);
      case 'UnaryExpression':
        return cpsExpr(expr.argument, v => {
          let unop = path.scope.generateUidIdentifier('unop');
          return k(unop).map(c => new CLet('const', unop, new BOp1(expr.operator, v), c));
        }, ek, path);
      case "FunctionExpression":
        let func = path.scope.generateUidIdentifier('func');
        return cpsStmt(expr.body,
          r => ret<CExpr,CExpr>(new CAdminApp(<t.Identifier>expr.params[0], [r])),
          r => ret<CExpr,CExpr>(new CAdminApp(<t.Identifier>expr.params[1], [r])),
          path).bind(body =>
            k(func).map(e =>
              new CLet('const', func,
                new BFun(expr.id, <t.Identifier[]>expr.params, body),
                e)));
      case "CallExpression":
        const callee = expr.callee;
        if (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.property) &&
          (callee.property.name === 'apply' ||
            callee.property.name === 'call')) {
          const bnd = path.scope.generateUidIdentifier('bind');
          return cpsExpr(callee.object, f =>
            cpsExprList(expr.arguments, args => {
              const kFun = path.scope.generateUidIdentifier('kFun');
              const kErr = path.scope.generateUidIdentifier('kErr');
              const r = path.scope.generateUidIdentifier('r');
              return k(r).bind(kn =>
                ek(r).map(ekn =>
                    new CLet('const', kFun, new BAdminFun(undefined, [r], kn),
                      new CLet('const', kErr, new BAdminFun(undefined, [r], ekn),
                        (<t.Identifier>callee.property).name === 'apply' ?
                        new CApplyApp(f, [kFun, kErr, ...args]) :
                        new CCallApp(f, [kFun, kErr, ...args])))));
            }, ek, path), ek, path);
        } else if (t.isMemberExpression(callee) &&
          t.isIdentifier(callee.property)) {
          const bnd = path.scope.generateUidIdentifier('bind');
          return cpsExpr(callee.object, f =>
            cpsExprList(expr.arguments, args => {
              const kFun = path.scope.generateUidIdentifier('kFun');
              const kErr = path.scope.generateUidIdentifier('kErr');
              const r = path.scope.generateUidIdentifier('r');
              return k(r).bind(kn =>
                ek(r).map(ekn =>
                  new CLet('const', bnd, new BGet(f, <t.Identifier>callee.property, false),
                    new CLet('const', kFun, new BAdminFun(undefined, [r], kn),
                      new CLet('const', kErr, new BAdminFun(undefined, [r], ekn),
                        new CCallApp(bnd, [kFun, kErr, f, ...args]))))));
            }, ek, path), ek, path);
        } else {
          return cpsExpr(callee, f =>
            cpsExprList(expr.arguments, args => {
              const kFun = path.scope.generateUidIdentifier('kFun');
              const kErr = path.scope.generateUidIdentifier('kErr');
              const r = path.scope.generateUidIdentifier('r');
              return k(r).bind(kn =>
                ek(r).map(ekn =>
                  new CLet('const', kFun, new BAdminFun(undefined, [r], kn),
                    new CLet('const', kErr, new BAdminFun(undefined, [r], ekn),
                      new CApp(f, [kFun, kErr, ...args])))));
            }, ek, path), ek, path);
        }
      case 'MemberExpression':
        return cpsExpr(expr.object, o =>
          cpsExpr(expr.property, p => {
            const obj = path.scope.generateUidIdentifier('obj');
            return k(obj).map(c => new CLet('const', obj, new BGet(o, p, expr.computed), c));
          }, ek, path), ek, path);
      case 'NewExpression':
        const tmp = path.scope.generateUidIdentifier('new');
        return cpsExpr(expr.callee, f =>
          cpsExprList(expr.arguments, args =>
            k(tmp).map(c =>
              new CLet('const', tmp, new BNew(f, args), c)), ek, path), ek, path);
      case 'ObjectExpression':
        return cpsObjMembers(<t.ObjectMember[]>expr.properties,
          (mems: AExpr[][]) => {
            const obj = path.scope.generateUidIdentifier('obj');
            const fields = new Map();
            mems.forEach(function (item) {
              const [id, v] = item;
              fields.set(id, v);
            });
            return k(obj).map(c => new CLet('const', obj, new BObj(fields), c));
          },
          ek,
          path);
      case 'SequenceExpression':
        return cpsExprList(expr.expressions, (vs: AExpr[]) => {
          const seq = path.scope.generateUidIdentifier('seq');
          return k(seq).map(c => new CLet('const', seq, new BSeq(vs), c));
        }, ek, path);
      case 'ThisExpression':
        const ths = path.scope.generateUidIdentifier('this');
        return k(ths).map(c => new CLet('const', ths, new BThis(), c));
      case 'UpdateExpression': {
        const tmp = path.scope.generateUidIdentifier('update');
        return k(tmp).bind(c =>
          cpsExpr(expr.argument, (v: AExpr) =>
            ret<CExpr,CExpr>(new CLet('const', tmp,
              new BIncrDecr(expr.operator, v, expr.prefix), c)), ek, path));
      }
    }
    throw new Error(`${expr.type} not yet implemented`);
  }

function cpsStmt(stmt: t.Statement,
  k: (arg: AExpr) => CPS<CExpr,CExpr>,
  ek: (arg: AExpr) => CPS<CExpr,CExpr>,
  path: NodePath<t.Node>): CPS<CExpr,CExpr> {
    switch (stmt.type) {
      case "BlockStatement": {
        let [head, ...tail] = stmt.body;
        if (head === undefined) {
          return k(undefExpr);
        } else if (tail === []) {
          return cpsStmt(head, k, ek, path);
        } else {
          return cpsStmt(head, v => cpsStmt(t.blockStatement(tail),
            k, ek, path), ek, path);
        }
      }
      case "BreakStatement":
        return cpsExpr(stmt.label, label =>
          ret<CExpr,CExpr>(new CAdminApp(label, [undefExpr])), ek, path);
      case "EmptyStatement":
        return k(undefExpr);
      case "ExpressionStatement":
        return cpsExpr(stmt.expression, _ =>
          k(undefExpr), ek, path);
      case "IfStatement":
        return cpsExpr(stmt.test, tst => {
          const cont = path.scope.generateUidIdentifier('if_cont');
          return k(cont).bind(if_cont =>
            cpsStmt(stmt.consequent, v => ret<CExpr,CExpr>(new CAdminApp(cont, [v])), ek, path)
            .bind(consequent =>
              cpsStmt(stmt.alternate, v => ret<CExpr,CExpr>(new CAdminApp(cont, [v])), ek, path)
              .map(alternate =>
                new CLet('const', cont, new BAdminFun(undefined, [cont], if_cont),
                  new ITE(tst, consequent, alternate)))));
        }, ek, path);
      case "LabeledStatement": {
        const kErr = path.scope.generateUidIdentifier('kErr');
        return cpsExpr(t.callExpression(t.memberExpression(
          t.functionExpression(undefined,
          [stmt.label, kErr], flatBodyStatement([stmt.body])), t.identifier('call')),
          [t.thisExpression()]), k, ek, path);
      }
      case "ReturnStatement":
        let returnK = (r: AExpr) =>
          ret<CExpr,CExpr>(new CAdminApp(<t.Identifier>(<ReturnStatement>stmt).kArg, [r]));
        return cpsExpr(stmt.argument, returnK, ek, path);
      case 'ThrowStatement':
        return cpsExpr(stmt.argument, ek, v =>
          ret<CExpr,CExpr>(new CAdminApp(v, [undefExpr])), path);
      case 'TryStatement':
        const kFun = path.scope.generateUidIdentifier('kFun');
        const kErr = path.scope.generateUidIdentifier('kErr');
        const fin = stmt.finalizer === null ?
          k : (v: AExpr) => cpsStmt(stmt.finalizer, k, ek, path);
        const err = stmt.handler === null ?
          ek : (e: AExpr) =>
          cpsStmt(stmt.handler.body, fin, ek, path).map(c =>
            new CLet('const', stmt.handler.param, new BAtom(e), c));
        return cpsExpr(t.callExpression(t.functionExpression(undefined,
          [kFun, kErr],
          stmt.block), []), fin, err, path);
      case "VariableDeclaration": {
        const { declarations } = stmt;
        const [head, ...tail] = declarations;
        if (head === undefined) {
          return k(undefExpr);
        } else if (tail === []) {
          return cpsExpr(head.init, v =>
            k(undefExpr).map(c => new CLet(stmt.kind, <t.Identifier>head.id, new BAtom(v), c)),
            ek, path);
        } else {
          return cpsExpr(head.init, v =>
            cpsStmt(t.variableDeclaration(stmt.kind, tail), k, ek, path).map(c =>
              new CLet(stmt.kind, <t.Identifier>head.id, new BAtom(v), c)),
            ek, path);
        }
      }
      default:
        throw new Error(`${stmt.type} not yet implemented`);
    }
  }

function generateBExpr(bexpr: BExpr): t.Expression {
  switch (bexpr.type) {
    case 'atom':
      return bexpr.atom;
    case 'BFun':
      return transformed(t.functionExpression(bexpr.id,
        bexpr.args,
        flatBodyStatement(generateJS(bexpr.body))));
    case 'BAdminFun':
      return t.arrowFunctionExpression(bexpr.args,
        flatBodyStatement(generateJS(bexpr.body)));
    case 'op2':
      return t.binaryExpression(bexpr.oper, bexpr.l, bexpr.r);
    case 'op1':
      return t.unaryExpression(bexpr.oper, bexpr.v);
    case 'lop':
      return t.logicalExpression(bexpr.oper, bexpr.l, bexpr.r);
    case 'assign':
      return t.assignmentExpression(bexpr.operator, <t.LVal>bexpr.x, bexpr.v);
    case 'obj':
      const properties : t.ObjectProperty[] = [];
      bexpr.fields.forEach((value, key) =>
        properties.push(t.objectProperty(key, value)));
      return t.objectExpression(properties);
    case 'get':
      return t.memberExpression(bexpr.object, bexpr.property, bexpr.computed);
    case 'incr/decr':
      return t.updateExpression(bexpr.operator, bexpr.argument, bexpr.prefix);
    case 'arraylit':
      return t.arrayExpression(bexpr.arrayItems);
    case 'seq':
      return t.sequenceExpression(bexpr.elements);
    case 'this':
      return t.thisExpression();
    case 'new':
      return t.newExpression(bexpr.f, bexpr.args);
    case 'update':
      throw new Error(`${bexpr.type} generation is not yet implemented`);
  }
}

function generateJS(cexpr: CExpr): t.Statement[] {
  switch (cexpr.type) {
    case 'app':
      return [t.returnStatement(t.callExpression(cexpr.f, cexpr.args))];
    case 'callapp':
      return [t.returnStatement(call(t.callExpression(cexpr.f, cexpr.args)))];
    case 'applyapp':
      return [t.returnStatement(apply(t.callExpression(cexpr.f, cexpr.args)))];
    case 'adminapp':
      return [t.returnStatement(administrative(t.callExpression(cexpr.f, cexpr.args)))];
    case 'ITE':
      return [t.ifStatement(cexpr.e1,
        flatBodyStatement(generateJS(cexpr.e2)),
        flatBodyStatement(generateJS(cexpr.e3)))];
    case 'let':
      const decl = letExpression(cexpr.x, generateBExpr(cexpr.named), cexpr.kind);
      return [decl,
        ...generateJS(cexpr.body)];
  }
}

const cpsExpression : Visitor = {
  Program: {
    enter(path: NodePath<t.Program>): void {
      const { body } = path.node;
      const onDone = t.identifier('onDone');
      const onError = t.identifier('onError');

      const cexpr = cpsStmt(t.blockStatement(body),
        v => ret<CExpr,CExpr>(new CAdminApp(onDone, [v])),
        v => ret<CExpr,CExpr>(new CAdminApp(onError, [v])), path).apply(x => x);

      const kont =
        t.functionExpression(undefined, [onDone, onError],
          t.blockStatement(generateJS(/*raiseFuns*/(cexpr))));
      const kontCall = administrative(t.callExpression(kont, [onDone, onError]));

      path.node.body = [t.expressionStatement(kontCall)];
    }
  }
};

module.exports = function() {
  return { visitor: cpsExpression };
};
