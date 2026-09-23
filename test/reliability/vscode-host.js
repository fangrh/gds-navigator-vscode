// Runs inside the real Extension Development Host, only in a test-owned profile.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
exports.run = async function () {
  const dir = process.env.GDS_TEST_BRIDGE;
  if (!dir) throw new Error('GDS_TEST_BRIDGE required');
  await vscode.extensions.getExtension('fangrh.gds-navigator').activate();
  const previous = await vscode.env.clipboard.readText();
  let last = 0;
  fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({ready:true}));
  try {
    while (true) {
      await new Promise(r=>setTimeout(r,100));
      let req; try { req=JSON.parse(fs.readFileSync(path.join(dir,'request.json'),'utf8')); } catch { continue; }
      if(req.id===last)continue; last=req.id;
      try {
        let result;
        if(req.action==='open') result=await vscode.commands.executeCommand('vscode.openWith',vscode.Uri.file(req.file),'gdsNavigator.viewer', {preview:false});
        else if(req.action==='image') result=await vscode.commands.executeCommand('gdsNavigator.insertImage',vscode.Uri.file(req.file));
        else if(req.action==='source') { const doc=await vscode.workspace.openTextDocument(req.file); result=await vscode.window.showTextDocument(doc); result=null; }
        else if(req.action==='build') result=await vscode.commands.executeCommand('gdsNavigator.runScript');
        else if(req.action==='copy') result=await vscode.commands.executeCommand('gdsNavigator.copyYaml');
        else if(req.action==='environmentPicker') { void vscode.commands.executeCommand('gdsNavigator.selectPythonEnv'); result=null; }
        else if(req.action==='notifications') result=await vscode.commands.executeCommand('notifications.showList');
        else if(req.action==='reviewUsage') result=await vscode.commands.executeCommand('gdsNavigator.reviewUsage');
        else if(req.action==='escapeQuickPick') result=await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        else if(req.action==='usageEnabled') { const config=vscode.workspace.getConfiguration('gdsNavigator', vscode.Uri.file(req.file || vscode.workspace.workspaceFolders[0].uri.fsPath)); result=await config.update('usageLogging.enabled', !!req.value, vscode.ConfigurationTarget.Workspace); }
        else if(req.action==='clipboard') result=await vscode.env.clipboard.readText();
        else if(req.action==='close') result=await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        else if(req.action==='tabs') result=vscode.window.tabGroups.all.flatMap(g=>g.tabs.map(t=>t.label));
        else if(req.action==='hidePanel') result=await vscode.commands.executeCommand('workbench.action.closePanel');
        else if(req.action==='stop') break;
        else throw new Error('Unknown test action');
        fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id:req.id,result:result??null}));
      }catch(e){fs.writeFileSync(path.join(dir,'response.json'),JSON.stringify({id:req.id,error:String(e)}));}
    }
  } finally { await vscode.env.clipboard.writeText(previous); }
};
