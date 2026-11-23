# assemble.py <tag> <media...>: everything found, as one list of what to blur -> <media>.masks.json; and the sheet of
# candidates a judge must look at -> look/<media>.cands.png with <media>.ask.json
import sys,json,os,cv2,numpy as np
from captions import captions,pad
def plate(img,box,W,H,maxx,maxy,tol=22):
    """How far a plate of one colour reaches past a box of words, each side, in pixels (0s when the words sit on the
    picture). The plate's colour is read beside the words, at their mid height (the box is padded past the letters there)."""
    x0,y0,x1,y1=box; h=y1-y0; ya=y0+int(0.35*h); yb=y1-int(0.35*h)
    if yb-ya<2 or x1-x0<16: return [0,0,0,0]
    side=np.concatenate([img[ya:yb,x0:x0+5].reshape(-1,3),img[ya:yb,x1-5:x1].reshape(-1,3)]).astype(np.int16); c=np.median(side,0)
    if np.mean(np.abs(side-c).max(1)<tol)<0.8: return [0,0,0,0]
    def run(line): return len(line)>0 and np.mean(np.abs(line.astype(np.int16)-c).max(1)<tol)>=0.85
    def rowok(y): return run(np.concatenate([img[y,x0:x0+8],img[y,x1-8:x1]]))
    L=0
    while L<maxx and x0-L-1>=0 and run(img[ya:yb,x0-L-1]): L+=1
    R=0
    while R<maxx and x1+R<W and run(img[ya:yb,x1+R]): R+=1
    top=ya
    while top-1>=max(0,y0-maxy) and rowok(top-1): top-=1
    bot=yb
    while bot+1<min(H,y1+maxy) and rowok(bot+1): bot+=1
    return [L,max(0,y0-top),R,max(0,bot-y1)]
def whole(tag,mid,box,frames,W,H,stamps=()):
    """A label's whole graphic: the plate of one colour its words sit on, measured on 20 frames (its colour may change
    from one to the next; the plate's reach doesn't). The words' own box when there's no plate."""
    x0,y0,x1,y1=box; h=y1-y0; w=x1-x0
    cap=cv2.VideoCapture(f'{tag}/src/{mid}.mp4'); fs=sorted(frames); pick=[fs[int(i*(len(fs)-1)/19)] for i in range(20)] if len(fs)>=20 else fs; gs=[]
    for f in pick:
        cap.set(cv2.CAP_PROP_POS_FRAMES,int(f)); ok,img=cap.read()
        if ok: gs.append(plate(img,[x0+2,y0+2,x1-2,y1-2],W,H,3*w,h))
    if len(gs)<8: return box
    gs=np.array(gs)
    if np.mean(gs.sum(1)>0)<0.6: return box
    g=np.median(gs[gs.sum(1)>0],0)
    if g[0]>=3*w-1 or g[2]>=3*w-1: return box   # ran on without end: a plain wall or sky, not a plate
    return [max(0,int(x0-g[0]-3)),max(0,int(y0-g[1]-3)),min(W,int(x1+g[2]+3)),min(H,int(y1+g[3]+3))]
def off_titles(masks,W,H,reads=()):
    """A channel's title across the top of the picture isn't a caption, though words that stay read like one line after
    another. Where labels stand along the top for a good part of the file, a caption or note that starts in that band is
    that title: a label (blurred, never sent to the model), cut to the band; a flicker of a few frames under it is nothing;
    and a label's box measured far taller than its words comes back to them, so the blur stays off a face below the title
    (Nov 23, the Trooper video: boxes of 1280 x 375 round "Red Crime Interrogations & Stories" had the model repaint the
    deputy's head, and a blur 143 px tall over a title 76 px tall hid his face for minutes)."""
    last=max((m[1] for m in masks),default=0)
    if last<=0: return masks
    tops=[m for m in masks if m[6]=='label' and m[3]<0.12*H and m[5]<0.35*H]
    on=np.zeros(last+2,bool)
    for m in tops: on[max(0,m[0]):min(last,m[1])+1]=True
    if on.sum()<0.25*(last+1): return masks
    band=int(np.percentile([m[5] for m in tops],90))
    words=[L for L in reads if (L[1]+L[3])/2<0.35*H]
    def fitted(m):
        inside=[L[3] for L in words if m[2]<=(L[0]+L[2])/2<=m[4] and m[3]<=(L[1]+L[3])/2<=m[5]]
        if len(inside)<5: return m
        # Nine in ten of its words end above this: the odd word read lower down is something else in the room.
        bottom=int(np.percentile(inside,90))+8
        return [*m[:5],bottom,m[6]] if m[5]-m[3]>1.25*(bottom-m[3]) else m
    out=[]; memo={}
    for m in masks:
        if m[6] in('subtitle','note'):
            if m[3]<min(band,0.12*H): m=[*m[:5],min(m[5],band),'label']
            elif m[3]<0.35*H and m[1]-m[0]<=6: continue
        if m[6]=='label' and m[3]<0.12*H and m[5]<0.35*H:
            k=tuple(m[2:6])
            if k not in memo: memo[k]=fitted(m)[5]
            m=[*m[:5],memo[k],'label']
        out.append(m)
    return out
def off_stamps(box,stamps):
    """A label's box kept off the camera's own stamp beside it: where the two overlap by a sliver (the label's plate and
    its padding reaching into the stamp's last line), the box stops short of the stamp (Nov 23, Boyfriends 20:06 to
    32:18: the blur over "OFFICER n" took the bottom line of the Axon stamp with it)."""
    x0,y0,x1,y1=box; mid=(y0+y1)/2
    for sx0,sy0,sx1,sy1 in stamps:
        if sx1<=x0 or sx0>=x1 or sy1<=y0 or sy0>=y1: continue
        if min(y1,sy1)-max(y0,sy0)>0.4*(y1-y0): continue   # mostly over it: not a sliver, left as it is
        if sy1<=mid: y0=max(y0,sy1+2)
        elif sy0>=mid: y1=min(y1,sy0-2)
    return [x0,y0,x1,y1] if y1-y0>=8 else list(box)
def label_masks(Z,marks,kinds=('label',),tag=None,mid=None):
    W,H=Z['W'],Z['H']; out=[]; stamps=Z.get('stamps') or []
    for m in marks:
        if m['kind'] not in kinds: continue
        places=[]; full=[r for r in m['reads'] if abs((r[3]-r[1])-m['w'])<0.12*m['w']]
        for r in (full if len(full)>=10 else m['reads']):
            for p in places:
                if abs(p['b'][0]-r[1])<50 and abs(p['b'][1]-r[2])<40: p['r'].append(r); break
            else: places.append({'b':r[1:5],'r':[r]})
        for p in places:
            if len(p['r'])<5: continue
            a=np.array(p['r']); box=[int(np.percentile(a[:,1],3)),int(np.percentile(a[:,2],3)),int(np.percentile(a[:,3],97)),int(np.percentile(a[:,4],97))]
            fs=sorted(a[:,0].tolist()); s=fs[0]; e=fs[0]
            if tag: box=whole(tag,mid,box,fs,W,H,Z['stamps'])
            # a faint mark is read now and then: it's taken as there between its sightings (up to 5 min apart)
            faint=len(fs)<0.5*(fs[-1]-fs[0])/10
            if faint and m['n']>=100: out.append([-1,10**9,*off_stamps(pad(box,W,H),stamps),m['kind']]); continue   # faint and all through the file: there throughout
            for f in fs[1:]:
                if f-e>(9000 if faint else 300): out.append([s-9,e+9,*off_stamps(pad(box,W,H),stamps),m['kind']]); s=f
                e=f
            out.append([s-9,e+9,*off_stamps(pad(box,W,H),stamps),m['kind']])
    return out
def backing(tag,mid,ms,W,H):
    """Captions on a plate of one colour: how far the plate reaches past the words, measured on 40 captions, and every
    caption's box grown by that. Nothing when the file's captions have no plate."""
    if len(ms)<40: return ms
    cap=cv2.VideoCapture(f'{tag}/src/{mid}.mp4'); gs=[]
    for m in ms[::max(1,len(ms)//40)][:40]:
        f=(m[0]+m[1])//2; cap.set(cv2.CAP_PROP_POS_FRAMES,f); ok,img=cap.read()
        if not ok: continue
        x0,y0,x1,y1=m[2:6]; h=y1-y0
        if h<8 or x1-x0<8: continue
        g=plate(img,[x0,y0,x1,y1],W,H,h,h)
        gs.append([v/h for v in g])
    if len(gs)<20: return ms
    gs=np.array(gs); plated=np.mean(gs.sum(1)>0)
    if plated<0.6: return ms
    grow=np.percentile(gs[gs.sum(1)>0],80,axis=0)+0.08
    out=[]
    for m in ms:
        h=m[5]-m[3]; out.append([m[0],m[1],max(0,int(m[2]-grow[0]*h)),max(0,int(m[3]-grow[1]*h)),min(W,int(m[4]+grow[2]*h)),min(H,int(m[5]+grow[3]*h)),m[6]])
    print('   ',mid,'captions sit on a plate; boxes grown by',np.round(grow,2),'line heights')
    return out
def build(tag,mid,yes=None):
    Z=json.load(open(f'{tag}/scan/{mid}.zone.json')); W,H=Z['W'],Z['H']
    ms=captions(tag,mid,Z)[0] if Z['zone'] else []
    ms=backing(tag,mid,ms,W,H)
    marks=json.load(open(f'{tag}/scan/{mid}.marks.json'))
    VV=json.load(open(f'{tag}/verdicts.json')) if os.path.exists(f'{tag}/verdicts.json') else {}
    ok=VV.get(mid+':labels')   # the labels and marks the judge called theirs (None: not judged yet, all taken)
    if ok is not None: marks=[m for m in marks if m['kind']=='unsure' or m['key'] in ok]
    ms+=label_masks(Z,marks,tag=tag,mid=mid)
    p=f'{tag}/scan/{mid}.roam.masks.json'
    if os.path.exists(p) and (ok is None or any(m['kind']=='roamer' and m['key'] in ok for m in json.load(open(f'{tag}/scan/{mid}.marks.json')))): ms+=json.load(open(p))
    deny=json.load(open(f'{tag}/verdicts.json')).get('deny_notes',[]) if os.path.exists(f'{tag}/verdicts.json') else []
    # their notes and narration outside the caption zone (the rule's own and the judge's yeses): those on screen together
    # are one block, covered whole from just before the first is read to just after the last
    one=[]
    for n in ([] if mid in deny else json.load(open(f'{tag}/scan/{mid}.notes.json'))):
        one.append([n['f0'],n['f1'],*n['box']])
    ask=ask_list(tag,mid)
    for c in ask:
        if not any(c['kind']==y[0] and c['text']==y[1] and abs(c['f']-y[2])<=30 for y in (yes or [])): continue
        if c['kind'] in('label','roamer'): continue
        if c['kind']=='unsure': ms+=label_masks(Z,[dict(c['mark'],kind='label')],tag=tag,mid=mid)
        else:
            rs=c['reads']; one.append([rs[0][0],rs[-1][0],min(r[1] for r in rs),min(r[2] for r in rs),max(r[3] for r in rs),max(r[4] for r in rs)])
    one.sort(); blocks=[]
    for o in one:
        for b in blocks:
            h=max(o[5]-o[3],b[5]-b[3])
            if o[0]<=b[1]+60 and min(o[5],b[5])-max(o[3],b[3])>-1.5*h and min(o[4],b[4])-max(o[2],b[2])>-6*h:
                b[1]=max(b[1],o[1]); b[2]=min(b[2],o[2]); b[3]=min(b[3],o[3]); b[4]=max(b[4],o[4]); b[5]=max(b[5],o[5]); break
        else: blocks.append(list(o))
    for b in blocks:
        box=pad(b[2:6],W,H); ex=int(0.5*(b[5]-b[3]))   # room for the end of a word the reader cut off
        ms.append([b[0]-10,b[1]+10,max(0,box[0]-ex),box[1],min(W,box[2]+ex),box[3],'note'])
    json.dump(ms,open(f'{tag}/scan/{mid}.masks.json','w')); return ms
def ask_list(tag,mid):
    marks=json.load(open(f'{tag}/scan/{mid}.marks.json')); out=[]
    for m in marks:
        if m['kind'] in('label','roamer') and m['reads']:
            full=[r for r in m['reads'] if abs((r[3]-r[1])-m['w'])<0.15*m['w']] or m['reads']; r=full[len(full)//2]
            out.append({'kind':m['kind'],'text':m['key'],'f':r[0],'box':r[1:5],'n':m['n'],'mark':m})
        if m['kind']=='unsure': out.append({'kind':'unsure','text':m['key'],'f':m['reads'][len(m['reads'])//2][0],'box':m['reads'][len(m['reads'])//2][1:5],'n':m['n'],'mark':m})
    notes=json.load(open(f'{tag}/scan/{mid}.notes.json'))
    for c in json.load(open(f'{tag}/scan/{mid}.cands.json')):
        r=c['reads'][len(c['reads'])//2]
        if any(n['f0']<=r[0]<=n['f1'] and abs(n['box'][0]-r[1])<40 and abs(n['box'][1]-r[2])<40 for n in notes): continue
        out.append({'kind':'one-off','text':c['text'],'f':r[0],'box':r[1:5],'n':c['n'],'reads':c['reads']})
    return out
def sheet(tag,mid):
    ask=ask_list(tag,mid); json.dump([{k:v for k,v in a.items() if k in('kind','text','f','box','n')} for a in ask],open(f'{tag}/scan/{mid}.ask.json','w'))
    if not ask: return 0
    cap=cv2.VideoCapture(f'{tag}/src/{mid}.mp4'); tiles=[]
    for i,a in enumerate(ask):
        cap.set(cv2.CAP_PROP_POS_FRAMES,a['f']); ok,img=cap.read()
        if not ok: img=np.zeros((720,1280,3),np.uint8)
        x0,y0,x1,y1=a['box']; cv2.rectangle(img,(x0-6,y0-6),(x1+6,y1+6),(0,255,0),2)
        cx,cy=(x0+x1)//2,(y0+y1)//2; w=max(480,int((x1-x0)*1.8)); h=w*9//16
        X0=max(0,min(img.shape[1]-w,cx-w//2)); Y0=max(0,min(img.shape[0]-h,cy-h//2)); t=cv2.resize(img[Y0:Y0+h,X0:X0+w],(480,270))
        cv2.rectangle(t,(0,0),(64,26),(0,0,0),-1); cv2.putText(t,f'#{i}',(4,20),cv2.FONT_HERSHEY_SIMPLEX,0.7,(0,255,255),2); tiles.append(t)
    for s in range(0,len(tiles),16):
        part=tiles[s:s+16]
        while len(part)%4: part.append(np.zeros_like(part[0]))
        cv2.imwrite(f'{tag}/look/{mid}.cands{s//16}.jpg',np.vstack([np.hstack(part[i:i+4]) for i in range(0,len(part),4)]))
    return len(ask)
if __name__=='__main__':
    for mid in sys.argv[2:]:
        ms=build(sys.argv[1],mid); n=sheet(sys.argv[1],mid)
        import collections; print(mid,dict(collections.Counter(m[6] for m in ms)),'| to judge:',n)
