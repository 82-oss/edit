# cands.py <tag> <media>: one-off words outside the caption zone that no rule settles (a note of theirs that floats, or a
# sign in the scene): each a candidate for the auditor to look at -> <media>.cands.json
import sys,json,re,difflib,numpy as np
from events import STAMP,letters
from zone import AXON
def cands(tag,mid):
    Z=json.load(open(f'{tag}/scan/{mid}.zone.json')); W,H=Z['W'],Z['H']
    marks=[m['key'] for m in json.load(open(f'{tag}/scan/{mid}.marks.json'))]
    def instamp(b): return any(b[0]>=s[0]-60 and b[2]<=s[2]+60 and b[1]>=s[1]-12 and b[3]<=s[3]+12 for s in Z['stamps'])
    def known(txt):
        k=re.sub(r'[^a-z0-9]','',txt.lower())
        return any(difflib.SequenceMatcher(None,k,w).ratio()>0.6 or (len(k)>=3 and (k in w or w in k)) for w in Z.get('scene',[])+marks)
    live=[]; done=[]; prev=None
    for l in open(f'{tag}/scan/{mid}.jsonl'):
        r=json.loads(l); f=r['f']
        if prev is not None and f-prev!=10: done+=live; live=[]
        nxt=[]; used=set()
        for L in r['lines']:
            cy=(L[1]+L[3])/2/H
            if L[5]<0.8 or letters(L[4])<5 or STAMP.search(L[4]) or AXON.search(L[4]) or instamp(L) or known(L[4]): continue
            if Z['zone'] and Z['zone'][0]<=cy<=Z['zone'][1]: continue
            best=None
            for i,t in enumerate(live):
                if i in used: continue
                p=t['r'][-1]
                if abs(p[1]-L[0])<160 and abs(p[2]-L[1])<120 and difflib.SequenceMatcher(None,p[5].lower(),L[4].lower()).ratio()>0.75: best=i; break
            if best is None: t={'r':[]}
            else: t=live[best]; used.add(best)
            t['r'].append([f,*L[:4],L[4],L[5]]); nxt.append(t)
        for i,t in enumerate(live):
            if i not in used:
                (nxt if f-t['r'][-1][0]<=20 else done).append(t)
        live=nxt; prev=f
    done+=live; out=[]
    for t in done:
        r=t['r']
        if len(r)<2 or max(x[6] for x in r)<0.93: continue
        hs=[x[4]-x[2] for x in r]
        out.append({'f0':r[0][0],'f1':r[-1][0],'n':len(r),'text':max(r,key=lambda x:x[6])[5],'reads':[x[:5] for x in r],'steady':max(hs)/max(1,min(hs))<1.25,'moved':float(np.hypot(r[-1][1]-r[0][1],r[-1][2]-r[0][2]))})
    return out
if __name__=='__main__':
    for mid in sys.argv[2:]:
        cs=cands(sys.argv[1],mid); json.dump(cs,open(f'{sys.argv[1]}/scan/{mid}.cands.json','w'))
        print(mid,len(cs),'candidates;',sum(c['n'] for c in cs),'reads; steady size',sum(c['steady'] for c in cs))
        for c in sorted(cs,key=lambda c:-c['n'])[:10]: print('   ',c['n'],c['f0'],repr(c['text'][:40]),'steady' if c['steady'] else 'size changes','moved',round(c['moved']))
