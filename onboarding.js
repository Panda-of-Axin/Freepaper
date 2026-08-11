/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */
'use strict';
const slides=[...document.querySelectorAll('.slide')];
const mode=new URLSearchParams(location.search).get('mode')||'help';
const EXAMPLE_CSV='\uFEFFdoi,url,title\r\n10.48550/arXiv.2010.08895,https://arxiv.org/pdf/2010.08895,Fourier Neural Operator for Parametric Partial Differential Equations\r\n,https://ieeexplore.ieee.org/document/9282004,Physics-Informed Neural Networks for Power Systems\r\n10.1002/inf2.12028,https://onlinelibrary.wiley.com/doi/full/10.1002/inf2.12028,Machine learning in materials science\r\n';
let index=0;
let showAll=false;
const $=(id)=>document.getElementById(id);
function render(){
  document.querySelector('.card')?.classList.toggle('show-all',showAll);
  slides.forEach((slide,i)=>slide.classList.toggle('active',showAll||i===index));
  $('progress').replaceChildren(...slides.map((_s,i)=>{const d=document.createElement('div');d.className=`dot ${(showAll||i<=index)?'active':''}`;return d;}));
  $('btnPrev').style.visibility=(showAll||index===0)?'hidden':'visible';
  $('btnHelpMode').textContent=showAll?'返回分步查看':'显示全部说明';
  $('btnNext').textContent=(showAll||index===slides.length-1)?(mode==='help'?'完成':'完成并开始使用'):'下一步';
}
async function downloadExample(button){
  if(button){button.disabled=true;button.textContent='正在准备…';}
  const result=await chrome.runtime.sendMessage({type:'DOWNLOAD_EXAMPLE_CSV'}).catch(()=>null);
  if(button){button.textContent=result?.ok?'已开始下载':'下载失败，可复制示例内容';setTimeout(()=>{button.disabled=false;button.textContent='下载示例 CSV';},1500);}
}
async function copyExample(button){
  await navigator.clipboard.writeText(EXAMPLE_CSV.replace(/^\uFEFF/,'')).catch(()=>null);
  if(button){const old=button.textContent;button.textContent='已复制';setTimeout(()=>button.textContent=old,1200);}
}
async function finish(){
  if(!$('understood').checked){
    if(!showAll){index=slides.length-1;render();}
    $('understood').focus();$('understood').parentElement.style.outline='2px solid #f59e0b';return;
  }
  await chrome.storage.local.set({freepaper_onboarding_completed_v202:true,freepaper_last_seen_release:'2.0.2'});
  try{window.close();}catch(_){location.href='about:blank';}
}
$('btnPrev').addEventListener('click',()=>{showAll=false;index=Math.max(0,index-1);render();});
$('btnNext').addEventListener('click',()=>{if(!showAll&&index<slides.length-1){index++;render();}else void finish();});
$('btnExample').addEventListener('click',(event)=>void downloadExample(event.currentTarget));
$('btnCopyExample').addEventListener('click',(event)=>void copyExample(event.currentTarget));
$('btnHelpMode').addEventListener('click',()=>{showAll=!showAll;render();window.scrollTo({top:0,behavior:'smooth'});});
$('btnDiagnostic').addEventListener('click',async()=>{const result=await chrome.runtime.sendMessage({type:'GET_DIAGNOSTIC_REPORT'}).catch(()=>null);$('diagnostic').textContent=result?.report||'Unable to read diagnostics.';$('diagnostic').style.display='block';$('btnCopy').style.display='inline-block';});
$('btnCopy').addEventListener('click',async()=>{await navigator.clipboard.writeText($('diagnostic').textContent).catch(()=>null);$('btnCopy').textContent='已复制';});
if(mode==='update'){$('heroSubtitle').textContent='本次更新：通用认证识别、IEEE 防循环、PDF 自动保存与下载追踪';}
if(mode==='help'){$('heroSubtitle').textContent='使用指南、设计原因与诊断中心';}
render();
